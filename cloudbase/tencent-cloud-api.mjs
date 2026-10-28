import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

const ACTIONS = Object.freeze({
  tcb: new Set([
    "DescribeEnvs",
    "DescribeBillingInfo",
    "DescribeHTTPServiceRoute",
    "DescribeEnvAccountCircle",
    "DescribeCreditsUsage",
    "DescribeBaasPackageList",
  ]),
  scf: new Set([
    "GetFunction",
    "ListFunctions",
    "GetFunctionAddress",
    "UpdateFunctionCode",
  ]),
});
const MAX_RESPONSE_BYTES = 5_000_000;
const REQUEST_TIMEOUT_MS = 25_000;
const ENV_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export function parseTencentCredentialFile(source) {
  if (typeof source !== "string" || source.length > 32_768) {
    throw new TypeError("Tencent credential file is invalid");
  }
  const fields = new Map();
  for (const line of source.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(SecretId|SecretKey|Token)=(.*)$/u.exec(trimmed);
    if (!match || fields.has(match[1])) {
      throw new TypeError("Tencent credential file is malformed");
    }
    let value = match[2].trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (value.length < 2 || value.at(-1) !== quote) {
        throw new TypeError("Tencent credential file is malformed");
      }
      value = value.slice(1, -1);
    }
    if (CONTROL_CHARACTERS.test(value) || value.length > 8_192) {
      throw new TypeError("Tencent credential file is malformed");
    }
    fields.set(match[1], value);
  }
  const credentials = {
    secretId: fields.get("SecretId") || "",
    secretKey: fields.get("SecretKey") || "",
    token: fields.get("Token") || "",
  };
  assertCredentials(credentials);
  return credentials;
}

export async function readTencentCredentials(path) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new Error("Unable to read Tencent credential file");
  }
  return parseTencentCredentialFile(source);
}

export function createTencentCloudClient({
  credentials,
  region,
  fetchImplementation = fetch,
  nowImplementation = Date.now,
}) {
  assertCredentials(credentials);
  if (typeof region !== "string" || !/^[a-z]{2}-[a-z]+$/u.test(region)) {
    throw new TypeError("Tencent Cloud region is invalid");
  }
  const { secretId, secretKey, token = "" } = credentials;
  return async function request(service, action, payload) {
    if (!Object.hasOwn(ACTIONS, service) || !ACTIONS[service].has(action)) {
      throw new TypeError("Tencent Cloud API action is not allowed");
    }
    if (!isPlainObject(payload)) {
      throw new TypeError("Tencent Cloud API payload is invalid");
    }
    if (action === "UpdateFunctionCode") assertCodeUpdate(payload);
    let body;
    try {
      body = JSON.stringify(payload);
    } catch {
      throw new TypeError("Tencent Cloud API payload is invalid");
    }
    const timestamp = Math.floor(nowImplementation() / 1_000);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
      throw new TypeError("Tencent Cloud API timestamp is invalid");
    }
    const date = new Date(timestamp * 1_000).toISOString().slice(0, 10);
    const host = `${service}.tencentcloudapi.com`;
    const contentType = "application/json; charset=utf-8";
    const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
    const signedHeaders = "content-type;host;x-tc-action";
    const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(body)}`;
    const scope = `${date}/${service}/tc3_request`;
    const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
    const signingKey = hmac(
      hmac(hmac(`TC3${secretKey}`, date), service),
      "tc3_request",
    );
    const signature = createHmac("sha256", signingKey)
      .update(stringToSign)
      .digest("hex");
    const headers = {
      "Content-Type": contentType,
      Host: host,
      "X-TC-Action": action,
      "X-TC-Version": service === "scf" ? "2018-04-16" : "2018-06-08",
      "X-TC-Region": region,
      "X-TC-Timestamp": String(timestamp),
      Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      ...(token ? { "X-TC-Token": token } : {}),
    };
    let data;
    let httpOk;
    try {
      const response = await fetchImplementation(`https://${host}`, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      httpOk = response.ok;
      data = JSON.parse(await readBoundedResponse(response))?.Response;
    } catch {
      throw new Error("Tencent Cloud API request or response failed");
    }
    if (data?.Error) {
      const code = data.Error.Code;
      const safeCode =
        typeof code === "string" &&
        /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/u.test(code) &&
        ![secretId, secretKey, token].some(
          (value) => value && code.includes(value),
        )
          ? code
          : "REDACTED_API_ERROR";
      throw new Error(`Tencent Cloud API error: ${safeCode}`);
    }
    if (!httpOk || !isPlainObject(data)) {
      throw new Error("Tencent Cloud API returned an invalid response");
    }
    return data;
  };
}

function assertCredentials(value) {
  if (
    !isPlainObject(value) ||
    ![value.secretId, value.secretKey].every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= 8_192 &&
        !CONTROL_CHARACTERS.test(item),
    ) ||
    (value.token !== undefined &&
      (typeof value.token !== "string" ||
        value.token.length > 8_192 ||
        CONTROL_CHARACTERS.test(value.token)))
  ) {
    throw new TypeError("Tencent credentials are invalid or incomplete");
  }
}

function assertCodeUpdate(payload) {
  const allowedKeys = new Set([
    "FunctionName",
    "Namespace",
    "Handler",
    "InstallDependency",
    "Code",
    "Publish",
  ]);
  if (
    Object.keys(payload).some((key) => !allowedKeys.has(key)) ||
    payload.FunctionName !== "operations-dashboard-api" ||
    typeof payload.Namespace !== "string" ||
    !ENV_ID_PATTERN.test(payload.Namespace) ||
    (payload.Handler !== undefined && payload.Handler !== "index.main") ||
    (payload.InstallDependency !== undefined &&
      !["TRUE", "FALSE"].includes(payload.InstallDependency)) ||
    (payload.Publish !== undefined && payload.Publish !== "FALSE") ||
    !isPlainObject(payload.Code) ||
    Object.keys(payload.Code).length !== 1 ||
    typeof payload.Code.ZipFile !== "string" ||
    payload.Code.ZipFile.length === 0 ||
    payload.Code.ZipFile.length > 2_000_000 ||
    payload.Code.ZipFile.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload.Code.ZipFile)
  ) {
    throw new TypeError("Dashboard code update payload is not allowed");
  }
}

async function readBoundedResponse(response) {
  const declaredSize = Number(response.headers?.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
    throw new Error("Response exceeds allowed size");
  }
  if (!response.body?.getReader) {
    const value = await response.text();
    if (Buffer.byteLength(value) > MAX_RESPONSE_BYTES) {
      throw new Error("Response exceeds allowed size");
    }
    return value;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Response exceeds allowed size");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

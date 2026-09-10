"use strict";

const { parseDocument } = require("htmlparser2");
const { ApiError } = require("./errors");
const { VERSION_PATTERN, canonicalizeDottedVersion } = require("./version");

const CODE_PATTERN =
  /^[^\s\\/?#\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]+$/u;
const VERSION_ID_PATTERN = /^[0-9]{19}$/;
const AD_ID_PATTERN = /^[0-9]{1,19}$/;
const UNSAFE_DISPLAY_CHARACTER_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/u;
const ALLOWED_RICH_TEXT_TAGS = [
  "b",
  "br",
  "div",
  "em",
  "i",
  "li",
  "ol",
  "p",
  "span",
  "strong",
  "ul",
];

function invalidRequest(message = "请求参数不合法") {
  return new ApiError(400, "request.invalid", message);
}

function validateVersionWrite(value) {
  assertPlainObject(value);
  assertExactKeys(
    value,
    [
      "name",
      "code",
      "codeVersion",
      "downloadUrl",
      "promptContent",
      "forcedUpdate",
      "promptUpdate",
      "stopUpdate",
      "updateContent",
      "updateCriteria",
      "versionCriteria",
    ],
    [
      "name",
      "code",
      "codeVersion",
      "downloadUrl",
      "promptContent",
      "forcedUpdate",
      "promptUpdate",
      "stopUpdate",
    ],
  );

  const result = {
    name: requireSafeText(value.name, 50),
    code: validateCode(value.code, 50),
    codeVersion: validateVersion(value.codeVersion),
    downloadUrl: requirePublicHttpsUrl(value.downloadUrl, 500),
    promptContent: requireSafeText(value.promptContent, 100),
    forcedUpdate: requireBoolean(value.forcedUpdate),
    promptUpdate: requireBoolean(value.promptUpdate),
    stopUpdate: requireBoolean(value.stopUpdate),
    updateContent: sanitizeRichText(
      value.updateContent === undefined ? "" : value.updateContent,
      10_000,
    ),
  };

  if (
    [result.forcedUpdate, result.promptUpdate, result.stopUpdate].filter(
      Boolean,
    ).length > 1
  ) {
    throw invalidRequest("更新状态不能互相冲突");
  }

  const hasOperator = Object.hasOwn(value, "updateCriteria");
  const hasCriteriaVersion = Object.hasOwn(value, "versionCriteria");
  if (hasOperator !== hasCriteriaVersion) {
    throw invalidRequest("更新条件必须成对提供");
  }
  if (hasOperator) {
    if (!new Set(["ge", "gt", "le", "lt"]).has(value.updateCriteria)) {
      throw invalidRequest();
    }
    result.updateCriteria = value.updateCriteria;
    result.versionCriteria = validateVersion(value.versionCriteria);
  }

  return {
    ...result,
    versionKey: canonicalizeDottedVersion(result.codeVersion),
  };
}

function validateAdCreate(value) {
  assertPlainObject(value);
  assertExactKeys(
    value,
    ["title", "url", "image", "content"],
    ["title", "url"],
  );
  return {
    title: requireSafeText(value.title, 100, { allowEmpty: true }),
    url: optionalPublicHttpsUrl(value.url, 255),
    image: optionalPublicHttpsUrl(
      value.image === undefined ? "" : value.image,
      255,
    ),
    content: sanitizeRichText(
      value.content === undefined ? "" : value.content,
      1_000,
    ),
  };
}

function validateAdUpdate(value) {
  assertPlainObject(value);
  assertExactKeys(
    value,
    ["title", "url", "image", "content"],
    ["title", "url", "content"],
  );
  const result = {
    title: requireSafeText(value.title, 100, { allowEmpty: true }),
    url: optionalPublicHttpsUrl(value.url, 255),
    content: sanitizeRichText(value.content, 1_000),
  };
  if (Object.hasOwn(value, "image")) {
    result.image = optionalPublicHttpsUrl(value.image, 255);
  }
  return result;
}

function validateCode(value, maxLength = 100) {
  if (
    typeof value !== "string" ||
    Array.from(value).length < 1 ||
    Array.from(value).length > maxLength ||
    value === "." ||
    value === ".." ||
    !CODE_PATTERN.test(value)
  ) {
    throw invalidRequest("应用编码不合法");
  }
  return value;
}

function validateVersion(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 50 ||
    !VERSION_PATTERN.test(value)
  ) {
    throw invalidRequest("版本号不合法");
  }
  return value;
}

function validateVersionId(value) {
  if (typeof value !== "string" || !VERSION_ID_PATTERN.test(value)) {
    throw invalidRequest("版本记录编号不合法");
  }
  return value;
}

function validateAdId(value) {
  if (typeof value !== "string" || !AD_ID_PATTERN.test(value)) {
    throw invalidRequest("广告编号不合法");
  }
  return value;
}

function decodePathSegment(value, validator) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw invalidRequest("路径参数不合法");
  }
  return validator(decoded);
}

function parseListQuery(urlValue, options = {}) {
  const maxPage = options.maxPage || 100;
  const allowSearch = Boolean(options.allowSearch);
  let url;
  try {
    url = new URL(urlValue || "/", "https://version-api.invalid");
  } catch {
    throw invalidRequest("查询参数不合法");
  }
  const allowed = new Set(["page", "size", ...(allowSearch ? ["search"] : [])]);
  for (const key of new Set(url.searchParams.keys())) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw invalidRequest("查询参数不合法");
    }
  }
  const page = parseBoundedInteger(
    url.searchParams.get("page") || "1",
    1,
    maxPage,
  );
  const size = parseBoundedInteger(
    url.searchParams.get("size") || "10",
    1,
    100,
  );
  let direction = "desc";
  if (allowSearch && url.searchParams.has("search")) {
    const search = url.searchParams.get("search");
    if (search === "createdTime=sort=asc") direction = "asc";
    else if (search !== "createdTime=sort=desc") {
      throw invalidRequest("search 参数不合法");
    }
  }
  return { page, size, direction };
}

function parseBoundedInteger(value, minimum, maximum) {
  if (!/^[0-9]+$/.test(value)) throw invalidRequest("分页参数不合法");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalidRequest("分页参数不合法");
  }
  return parsed;
}

function requireBoolean(value) {
  if (typeof value !== "boolean") throw invalidRequest();
  return value;
}

function requireSafeText(value, maxCodePoints, options = {}) {
  if (typeof value !== "string") throw invalidRequest();
  const length = Array.from(value).length;
  if (
    length > maxCodePoints ||
    (!options.allowEmpty && length === 0) ||
    (!options.allowMarkup && /[<>]/u.test(value)) ||
    UNSAFE_DISPLAY_CHARACTER_PATTERN.test(value)
  ) {
    throw invalidRequest("文本内容不合法");
  }
  return value;
}

function sanitizeRichText(value, maxCodePoints) {
  const text = requireSafeText(value, maxCodePoints, {
    allowEmpty: true,
    allowMarkup: true,
  });
  const document = parseDocument(text, {
    decodeEntities: true,
    lowerCaseAttributeNames: true,
    lowerCaseTags: true,
    recognizeSelfClosing: true,
    xmlMode: false,
  });
  const sanitized = renderSafeNodes(document.children, 0);
  requireSafeText(sanitized, maxCodePoints, {
    allowEmpty: true,
    allowMarkup: true,
  });
  return sanitized;
}

function renderSafeNodes(nodes, depth) {
  if (depth > 20) throw invalidRequest("富文本嵌套过深");
  let output = "";
  for (const node of nodes || []) {
    if (node.type === "text") {
      output += escapeHtmlText(node.data || "");
      continue;
    }
    if (node.type !== "tag" || !ALLOWED_RICH_TEXT_TAGS.includes(node.name)) {
      // Drop both an unsafe element and its descendants. No attributes are
      // emitted, so scripts, event handlers, URLs and local bridges cannot
      // survive sanitization and be reinterpreted by the desktop WebView.
      continue;
    }
    const name = node.name.toLowerCase();
    if (name === "br") {
      output += "<br>";
      continue;
    }
    output += `<${name}>${renderSafeNodes(node.children, depth + 1)}</${name}>`;
  }
  return output;
}

function escapeHtmlText(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function requirePublicHttpsUrl(value, maxLength) {
  if (!isPublicHttpsUrl(value, maxLength, false)) {
    throw invalidRequest("URL 不合法");
  }
  return value;
}

function optionalPublicHttpsUrl(value, maxLength) {
  if (!isPublicHttpsUrl(value, maxLength, true)) {
    throw invalidRequest("URL 不合法");
  }
  return value;
}

function isPublicHttpsUrl(value, maxLength, allowEmpty) {
  if (typeof value !== "string") return false;
  if (allowEmpty && value === "") return true;
  const length = Array.from(value).length;
  if (length < 1 || length > maxLength || /\s/u.test(value)) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hostname === ""
  ) {
    return false;
  }
  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
  return (
    isPotentiallyPublicHostname(hostname) &&
    !isNonPublicIpv4(hostname) &&
    !isNonPublicIpv6(hostname)
  );
}

function isPotentiallyPublicHostname(hostname) {
  if (!hostname.includes(".") && !hostname.includes(":")) return false;
  return ![
    ".example",
    ".home.arpa",
    ".internal",
    ".invalid",
    ".local",
    ".localhost",
    ".onion",
    ".test",
  ].some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix));
}

function isNonPublicIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^[0-9]{1,3}$/.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return true;
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 88 && octets[2] === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && octets[2] === 100) ||
    (first === 203 && second === 0 && octets[2] === 113) ||
    first >= 224
  );
}

function isNonPublicIpv6(hostname) {
  if (!hostname.includes(":")) return false;
  return (
    hostname.startsWith("::") ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    /^fe[89a-f]/.test(hostname) ||
    hostname.startsWith("ff") ||
    hostname.startsWith("2001:db8:")
  );
}

function assertPlainObject(value) {
  if (!isPlainObject(value)) throw invalidRequest();
}

function assertExactKeys(value, allowedKeys, requiredKeys) {
  const allowed = new Set(allowedKeys);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    requiredKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw invalidRequest("请求字段不合法");
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

module.exports = {
  AD_ID_PATTERN,
  CODE_PATTERN,
  VERSION_ID_PATTERN,
  decodePathSegment,
  invalidRequest,
  isPlainObject,
  isPublicHttpsUrl,
  parseListQuery,
  sanitizeRichText,
  validateAdCreate,
  validateAdId,
  validateAdUpdate,
  validateCode,
  validateVersion,
  validateVersionId,
  validateVersionWrite,
};

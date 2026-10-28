import { isValidSemVer } from "./semver.js";
import { isRecord, isSafeExternalUrl, isUuidV4 } from "./validation.js";

export const CLIENT_UPDATE_ORIGIN = "https://update.meetelf.com";
export const LOCAL_CLIENT_UPDATE_ORIGIN = "http://127.0.0.1:8080";
export type UpdateTrigger = "startup" | "scheduled" | "manual" | "pre_install";
export interface ClientUpdateRequest {
  current_version: string;
  channel: "stable" | "beta";
  os: "windows" | "macos" | "ubuntu" | "debian";
  os_version: string;
  architecture: "x86_64" | "arm64";
  installation_type: "installed" | "portable";
  installation_id: string;
  locale?: string;
  trigger: UpdateTrigger;
  capabilities: ("download" | "auto_install")[];
}
export interface ClientUpdateArtifact {
  id: string;
  size_bytes: number;
  sha256: string;
  download_url: string | null;
  manual_download_page_url: string | null;
}
export interface ClientUpdateSnapshot {
  id: string;
  app_id: string;
  server_time: string;
  expires_at: string;
  decision: "no_update" | "update_available" | "update_unavailable";
  reason: string;
  required: boolean;
  enforcement: "none" | "block_new_operations";
  action:
    "none" | "download_and_install" | "auto_install" | "open_download_page";
  force_after: string | null;
  next_check_after_seconds: number;
  mandatory_cache_expires_at: string | null;
  release: {
    id: string;
    version: string;
    notes: {
      locale: string;
      title: string;
      items: { category: string; text: string }[];
    };
  } | null;
  artifact: ClientUpdateArtifact | null;
}
export type ClientUpdateResult =
  | { kind: "snapshot"; snapshot: ClientUpdateSnapshot }
  | {
      kind: "error";
      reason: "invalid_config" | "unavailable" | "invalid_response";
      status?: number;
      retryAfter?: string;
    };
export interface ClientUpdateServiceConfig {
  appId: string;
  /** Client-only shared token, supplied by the host at runtime. */
  token: string;
  /** Production by default; only the explicitly requested loopback endpoint is allowed for local tests. */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** A single checker serializes checks; the caller also serializes downloads. */
export class ClientUpdateService {
  #inflight: Promise<ClientUpdateResult> | undefined;
  constructor(private readonly config: ClientUpdateServiceConfig) {}
  check(request: ClientUpdateRequest): Promise<ClientUpdateResult> {
    if (this.#inflight)
      return Promise.resolve({ kind: "error", reason: "unavailable" });
    const pending = this.#check(request).finally(() => {
      this.#inflight = undefined;
    });
    this.#inflight = pending;
    return pending;
  }
  async #check(request: ClientUpdateRequest): Promise<ClientUpdateResult> {
    const { appId, token } = this.config;
    const origin = resolveUpdateOrigin(this.config.baseUrl);
    if (
      !origin ||
      !/^[a-z][a-z0-9-]{2,63}$/.test(appId) ||
      typeof token !== "string" ||
      !/^[^\s\x00-\x1f\x7f]{32,128}$/.test(token) ||
      !validRequest(request)
    )
      return { kind: "error", reason: "invalid_config" };
    const body: ClientUpdateRequest = {
      current_version: request.current_version,
      channel: request.channel,
      os: request.os,
      os_version: request.os_version,
      architecture: request.architecture,
      installation_type: request.installation_type,
      installation_id: request.installation_id,
      ...(request.locale === undefined ? {} : { locale: request.locale }),
      trigger: request.trigger,
      capabilities: [...request.capabilities],
    };
    const controller = new AbortController();
    const ms = this.config.timeoutMs;
    let timeout: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => {
          controller.abort();
          reject(new Error("timeout"));
        },
        Number.isInteger(ms) && ms! > 0 && ms! <= 30000 ? ms : 10000,
      );
    });
    try {
      const response = await Promise.race([
        (this.config.fetch ?? fetch)(
          `${origin}/api/v1/apps/${encodeURIComponent(appId)}/update-checks`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, application/problem+json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
            cache: "no-store",
            redirect: "error",
            credentials: "omit",
          },
        ),
        timedOut,
      ]);
      if (response.status !== 201)
        return {
          kind: "error",
          reason: "unavailable",
          status: response.status,
          ...(response.headers.get("Retry-After")
            ? { retryAfter: response.headers.get("Retry-After")! }
            : {}),
        };
      const text = await Promise.race([response.text(), timedOut]);
      if (text.length > 131072)
        return { kind: "error", reason: "invalid_response" };
      const snapshot = parseClientUpdateSnapshot(
        JSON.parse(text) as unknown,
        appId,
        origin,
      );
      return snapshot &&
        (snapshot.action !== "auto_install" ||
          body.capabilities.includes("auto_install")) &&
        (snapshot.action !== "download_and_install" ||
          body.capabilities.includes("download"))
        ? { kind: "snapshot", snapshot }
        : { kind: "error", reason: "invalid_response" };
    } catch (error) {
      return {
        kind: "error",
        reason:
          error instanceof SyntaxError ? "invalid_response" : "unavailable",
      };
    } finally {
      clearTimeout(timeout!);
    }
  }
}
function validRequest(r: ClientUpdateRequest): boolean {
  return (
    isRecord(r) &&
    isValidSemVer(r.current_version) &&
    ["stable", "beta"].includes(r.channel) &&
    ["windows", "macos", "ubuntu", "debian"].includes(r.os) &&
    /^\d+(?:\.\d+){1,3}$/.test(r.os_version) &&
    ["x86_64", "arm64"].includes(r.architecture) &&
    ["installed", "portable"].includes(r.installation_type) &&
    isUuidV4(r.installation_id) &&
    ["startup", "scheduled", "manual", "pre_install"].includes(r.trigger) &&
    Array.isArray(r.capabilities) &&
    r.capabilities.every((x) => ["download", "auto_install"].includes(x)) &&
    new Set(r.capabilities).size === r.capabilities.length &&
    (!r.capabilities.includes("auto_install") ||
      r.capabilities.includes("download")) &&
    (r.locale === undefined || typeof r.locale === "string")
  );
}
const date = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v));
const nullableDate = (v: unknown): boolean => v === null || date(v);
const id = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 200;
function resolveUpdateOrigin(baseUrl: string | undefined): string | null {
  if (baseUrl === undefined) return CLIENT_UPDATE_ORIGIN;
  if (typeof baseUrl !== "string") return null;
  for (const origin of [CLIENT_UPDATE_ORIGIN, LOCAL_CLIENT_UPDATE_ORIGIN]) {
    if (baseUrl === origin || baseUrl === `${origin}/`) return origin;
  }
  return null;
}

function isUpdateDownloadUrl(value: unknown, origin: string): boolean {
  if (typeof value !== "string" || !value.startsWith(`${origin}/`))
    return false;
  try {
    const parsed = new URL(value);
    if (
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    )
      return false;
    return origin === LOCAL_CLIENT_UPDATE_ORIGIN || isSafeExternalUrl(value);
  } catch {
    return false;
  }
}
/** Unknown states fail closed; never render release notes as HTML. */
export function parseClientUpdateSnapshot(
  v: unknown,
  appId: string,
  baseUrl: string = CLIENT_UPDATE_ORIGIN,
): ClientUpdateSnapshot | null {
  const origin = resolveUpdateOrigin(baseUrl);
  if (!origin) return null;
  if (
    !isRecord(v) ||
    !id(v.id) ||
    v.app_id !== appId ||
    !date(v.server_time) ||
    !date(v.expires_at) ||
    Date.parse(v.expires_at) <= Date.parse(v.server_time) ||
    !["no_update", "update_available", "update_unavailable"].includes(
      v.decision as string,
    ) ||
    !id(v.reason) ||
    typeof v.required !== "boolean" ||
    !["none", "block_new_operations"].includes(v.enforcement as string) ||
    ![
      "none",
      "download_and_install",
      "auto_install",
      "open_download_page",
    ].includes(v.action as string) ||
    !nullableDate(v.force_after) ||
    !nullableDate(v.mandatory_cache_expires_at) ||
    !Number.isSafeInteger(v.next_check_after_seconds) ||
    (v.next_check_after_seconds as number) < 0
  )
    return null;
  if (v.decision !== "update_available") {
    if (v.enforcement !== "none" || v.action !== "none") return null;
    if (
      v.decision === "no_update" &&
      (v.release !== null || v.artifact !== null || v.required !== false)
    )
      return null;
    // Do not expose unvalidated nested objects to typed consumers.
    if (v.decision === "update_unavailable" && v.release !== null) {
      if (!isRelease(v.release)) return null;
    }
    if (v.artifact !== null && !isArtifact(v.artifact)) return null;
  } else {
    if (!isRelease(v.release) || !isArtifact(v.artifact) || v.action === "none")
      return null;
    if (
      v.enforcement === "block_new_operations" &&
      (v.required !== true ||
        !date(v.mandatory_cache_expires_at) ||
        Date.parse(v.mandatory_cache_expires_at) >
          Date.parse(v.server_time) + 86_400_000)
    )
      return null;
    if (v.action === "open_download_page") {
      if (!isSafeExternalUrl(v.artifact.manual_download_page_url)) return null;
    } else if (
      !isUpdateDownloadUrl(v.artifact.download_url, origin) ||
      !Number.isSafeInteger(v.artifact.size_bytes) ||
      (v.artifact.size_bytes as number) <= 0 ||
      typeof v.artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(v.artifact.sha256)
    )
      return null;
  }
  return v as unknown as ClientUpdateSnapshot;
}
function isRelease(
  v: unknown,
): v is NonNullable<ClientUpdateSnapshot["release"]> {
  return (
    isRecord(v) &&
    id(v.id) &&
    isValidSemVer(v.version) &&
    isRecord(v.notes) &&
    typeof v.notes.locale === "string" &&
    typeof v.notes.title === "string" &&
    Array.isArray(v.notes.items) &&
    v.notes.items.every(
      (x: unknown) =>
        isRecord(x) &&
        typeof x.category === "string" &&
        typeof x.text === "string",
    )
  );
}
function isArtifact(v: unknown): v is ClientUpdateArtifact {
  return (
    isRecord(v) &&
    id(v.id) &&
    Number.isSafeInteger(v.size_bytes) &&
    (v.size_bytes as number) > 0 &&
    typeof v.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(v.sha256) &&
    (v.download_url === null || typeof v.download_url === "string") &&
    (v.manual_download_page_url === null ||
      typeof v.manual_download_page_url === "string")
  );
}
/** Call only after independently verifying the downloaded size and SHA-256. */
export function isSameInstallTarget(
  original: ClientUpdateSnapshot,
  fresh: ClientUpdateSnapshot,
): boolean {
  return (
    original.decision === "update_available" &&
    fresh.decision === "update_available" &&
    original.id !== fresh.id &&
    (original.action === "download_and_install" ||
      original.action === "auto_install") &&
    typeof original.artifact?.sha256 === "string" &&
    typeof fresh.artifact?.sha256 === "string" &&
    original.app_id === fresh.app_id &&
    original.release?.version === fresh.release?.version &&
    original.artifact?.id === fresh.artifact?.id &&
    original.artifact?.size_bytes === fresh.artifact?.size_bytes &&
    original.artifact?.sha256.toLowerCase() ===
      fresh.artifact?.sha256.toLowerCase() &&
    original.action === fresh.action
  );
}

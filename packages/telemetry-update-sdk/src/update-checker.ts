import { DEFAULT_APPLICATION_VERSION_TIMEOUT_MS } from "./constants.js";
import type {
  ApplicationVersionCheckerConfig,
  ApplicationVersionData,
  ApplicationVersionDecision,
  ApplicationVersionFetch,
  ApplicationVersionHostHooks,
  DebugLogger,
  NoApplicationVersionDecision,
} from "./types.js";
import {
  isRecord,
  isSafeDisplayText,
  isSafeExternalUrl,
} from "./validation.js";

const BASE_PATH = "/tools/version-control/v1";
const RESPONSE_KEYS = [
  "update",
  "downloadUrl",
  "promptContent",
  "forcedUpdate",
  "promptUpdate",
  "stopUpdate",
  "updateContent",
] as const;
const CODE_PATTERN =
  /^(?!\.{1,2}$)[^\s\\/?#\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]+$/u;
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+)*$/;
const UNSAFE_CONTENT_CHARACTER_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/u;
const MAX_RESPONSE_CHARACTERS = 16_384;
const MAX_URL_CHARACTERS = 500;
const MAX_PROMPT_CODE_POINTS = 100;
const MAX_UPDATE_CONTENT_CODE_POINTS = 10_000;
const MAX_CREDENTIAL_CHARACTERS = 512;

export class ApplicationVersionChecker {
  readonly #config: ApplicationVersionCheckerConfig;
  readonly #timeoutMs: number;

  constructor(config: ApplicationVersionCheckerConfig) {
    this.#config = config;
    this.#timeoutMs = normalizeTimeout(config.timeoutMs);
  }

  async check(): Promise<ApplicationVersionDecision> {
    try {
      if (this.#config.enabled === false) return none("disabled");
      if (!isValidCheckerConfig(this.#config)) return none("invalid_config");

      const requestUrl = buildApplicationVersionCheckUrl(
        this.#config.baseUrl,
        this.#config.code,
        this.#config.currentVersion,
      );
      if (!requestUrl) return none("invalid_config");

      const responseText = await this.#fetchResponse(requestUrl);
      if (responseText === null) return none("unavailable");

      let raw: unknown;
      try {
        raw = JSON.parse(responseText) as unknown;
      } catch {
        return none("invalid_response");
      }
      const data = parseApplicationVersionData(raw);
      return data ? decideApplicationVersion(data) : none("invalid_response");
    } catch (error) {
      this.#debug("application_version_check_failed", error);
      return none("unavailable");
    }
  }

  async #fetchResponse(url: string): Promise<string | null> {
    const fetcher = this.#config.fetch ?? defaultFetch;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("application_version_timeout"));
      }, this.#timeoutMs);
    });

    try {
      const response = await Promise.race([
        fetcher(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            "x-app-key": this.#config.appKey,
            "x-app-secret": this.#config.appSecret,
          },
          signal: controller.signal,
          cache: "no-store",
        }),
        timeoutPromise,
      ]);
      if (!response.ok) return null;
      const text = await Promise.race([response.text(), timeoutPromise]);
      return text.length <= MAX_RESPONSE_CHARACTERS ? text : null;
    } catch (error) {
      this.#debug("application_version_fetch_failed", error);
      return null;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  #debug(message: string, error: unknown): void {
    try {
      this.#config.logger?.debug(message, {
        error: error instanceof Error ? error.name : "unknown",
      });
    } catch {
      // Checks stay silent even if an injected logger is broken. Credentials,
      // request URLs and response bodies are never included in debug context.
    }
  }
}

export function parseApplicationVersionData(
  value: unknown,
): ApplicationVersionData | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== RESPONSE_KEYS.length ||
    !RESPONSE_KEYS.every((key) => Object.hasOwn(value, key)) ||
    typeof value.update !== "boolean" ||
    typeof value.downloadUrl !== "string" ||
    Array.from(value.downloadUrl).length > MAX_URL_CHARACTERS ||
    !isSafeExternalUrl(value.downloadUrl) ||
    !isSafePromptContent(value.promptContent) ||
    typeof value.forcedUpdate !== "boolean" ||
    typeof value.promptUpdate !== "boolean" ||
    typeof value.stopUpdate !== "boolean" ||
    !isSafeUpdateContent(value.updateContent) ||
    !isValidStateCombination(
      value.update,
      value.forcedUpdate,
      value.promptUpdate,
      value.stopUpdate,
    )
  ) {
    return null;
  }

  return {
    update: value.update,
    downloadUrl: value.downloadUrl,
    promptContent: value.promptContent,
    forcedUpdate: value.forcedUpdate,
    promptUpdate: value.promptUpdate,
    stopUpdate: value.stopUpdate,
    updateContent: value.updateContent,
  };
}

export function decideApplicationVersion(
  data: ApplicationVersionData,
): ApplicationVersionDecision {
  if (data.stopUpdate) return { kind: "stopped", data };
  if (!data.update) return none("up_to_date");
  return data.forcedUpdate
    ? { kind: "required", data }
    : { kind: "optional", data };
}

export async function runApplicationVersionHostHooks(
  decision: ApplicationVersionDecision,
  hooks: ApplicationVersionHostHooks,
  logger?: DebugLogger,
): Promise<void> {
  try {
    if (decision.kind === "optional") {
      await hooks.onOptionalUpdate?.(decision);
    } else if (decision.kind === "required") {
      await hooks.onRequiredUpdate?.(decision);
    } else if (decision.kind === "stopped") {
      await hooks.onStoppedUpdate?.(decision);
    } else {
      await hooks.onNoUpdate?.(decision);
    }
  } catch (error) {
    try {
      logger?.debug("update_host_hook_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    } catch {
      // Hook and debug failures never escape the integration helper.
    }
  }
}

export function buildApplicationVersionCheckUrl(
  baseUrl: string,
  code: string,
  currentVersion: string,
): string | null {
  if (
    !isCanonicalApplicationVersionBaseUrl(baseUrl) ||
    !isApplicationCode(code) ||
    !isApplicationVersion(currentVersion)
  ) {
    return null;
  }
  const base = new URL(baseUrl);
  base.pathname = `${BASE_PATH}/versions/${encodeURIComponent(code)}/${encodeURIComponent(currentVersion)}`;
  return isSafeExternalUrl(base.toString()) ? base.toString() : null;
}

export function isCanonicalApplicationVersionBaseUrl(value: unknown): boolean {
  if (!isSafeExternalUrl(value)) return false;
  const parsed = new URL(value);
  return (
    parsed.pathname === BASE_PATH && parsed.search === "" && parsed.hash === ""
  );
}

export function isApplicationCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Array.from(value).length >= 1 &&
    Array.from(value).length <= 100 &&
    CODE_PATTERN.test(value)
  );
}

export function isApplicationVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 50 &&
    VERSION_PATTERN.test(value)
  );
}

function isSafeUpdateContent(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Array.from(value).length <= MAX_UPDATE_CONTENT_CODE_POINTS &&
    !UNSAFE_CONTENT_CHARACTER_PATTERN.test(value)
  );
}

function isSafePromptContent(value: unknown): value is string {
  return (
    isSafeDisplayText(value, MAX_PROMPT_CODE_POINTS) &&
    !value.includes("<") &&
    !value.includes(">")
  );
}

function isValidStateCombination(
  update: boolean,
  forcedUpdate: boolean,
  promptUpdate: boolean,
  stopUpdate: boolean,
): boolean {
  const enabledStates = [forcedUpdate, promptUpdate, stopUpdate].filter(
    Boolean,
  ).length;
  if (enabledStates > 1) return false;
  if (!update && (forcedUpdate || promptUpdate)) return false;
  if (update && stopUpdate) return false;
  return true;
}

function isValidCheckerConfig(
  config: ApplicationVersionCheckerConfig,
): boolean {
  return (
    isCanonicalApplicationVersionBaseUrl(config.baseUrl) &&
    isApplicationCode(config.code) &&
    isApplicationVersion(config.currentVersion) &&
    isCredential(config.appKey) &&
    isCredential(config.appSecret)
  );
}

function isCredential(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_CREDENTIAL_CHARACTERS &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function normalizeTimeout(value: number | undefined): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 30_000
    ? value
    : DEFAULT_APPLICATION_VERSION_TIMEOUT_MS;
}

function none(
  reason: NoApplicationVersionDecision["reason"],
): NoApplicationVersionDecision {
  return { kind: "none", reason };
}

const defaultFetch: ApplicationVersionFetch = async (url, init) => {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("fetch_unavailable");
  }
  return globalThis.fetch(url, {
    method: init.method,
    headers: init.headers,
    signal: init.signal,
    cache: init.cache ?? "no-store",
    credentials: "omit",
    redirect: "error",
  });
};

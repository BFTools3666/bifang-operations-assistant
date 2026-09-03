import {
  DEFAULT_UPDATE_TIMEOUT_MS,
  UPDATE_SCHEMA_VERSION,
} from "./constants.js";
import { compareSemVer, isValidSemVer } from "./semver.js";
import type {
  DebugLogger,
  NoUpdateDecision,
  UpdateCheckerConfig,
  UpdateConfig,
  UpdateDecision,
  UpdateFetch,
  UpdateHostHooks,
} from "./types.js";
import {
  isAppId,
  isPlatform,
  isRecord,
  isSafeExternalUrl,
  isUuidV4,
} from "./validation.js";

const UPDATE_CONFIG_KEYS = [
  "schema_version",
  "app_id",
  "platform",
  "enabled",
  "latest_version",
  "min_supported_version",
  "force_update",
  "rollout",
  "download_url",
  "release_notes_url",
] as const;
const MAX_UPDATE_CONFIG_CHARACTERS = 16_384;

export class UpdateChecker {
  readonly #config: UpdateCheckerConfig;
  readonly #timeoutMs: number;

  constructor(config: UpdateCheckerConfig) {
    this.#config = config;
    this.#timeoutMs = normalizeTimeout(config.timeoutMs);
  }

  async check(): Promise<UpdateDecision> {
    try {
      if (this.#config.enabled === false) {
        return none("disabled");
      }
      if (!isValidCheckerConfig(this.#config)) {
        return none("invalid_config");
      }

      const requestUrl = buildUpdateUrl(
        this.#config.baseUrl,
        this.#config.appId,
        this.#config.platform,
      );
      if (!requestUrl) {
        return none("invalid_config");
      }

      const responseText = await this.#fetchConfig(requestUrl);
      if (responseText === null) {
        return none("unavailable");
      }

      let rawConfig: unknown;
      try {
        rawConfig = JSON.parse(responseText) as unknown;
      } catch {
        return none("invalid_config");
      }
      const updateConfig = parseUpdateConfig(
        rawConfig,
        this.#config.appId,
        this.#config.platform,
      );
      if (!updateConfig) {
        return none("invalid_config");
      }

      return decideUpdate(
        this.#config.currentVersion,
        this.#config.installId,
        updateConfig,
      );
    } catch (error) {
      this.#debug("update_check_failed", error);
      return none("unavailable");
    }
  }

  async #fetchConfig(url: string): Promise<string | null> {
    const fetcher = this.#config.fetch ?? defaultFetch;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("update_timeout"));
      }, this.#timeoutMs);
    });

    try {
      const response = await Promise.race([
        fetcher(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
      if (!response.ok) {
        return null;
      }
      const responseText = await Promise.race([
        response.text(),
        timeoutPromise,
      ]);
      return responseText.length <= MAX_UPDATE_CONFIG_CHARACTERS
        ? responseText
        : null;
    } catch (error) {
      this.#debug("update_fetch_failed", error);
      return null;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  #debug(message: string, error: unknown): void {
    try {
      this.#config.logger?.debug(message, {
        error: error instanceof Error ? error.name : "unknown",
      });
    } catch {
      // Update checks remain silent even if an injected logger is broken.
    }
  }
}

export function parseUpdateConfig(
  value: unknown,
  expectedAppId?: string,
  expectedPlatform?: UpdateConfig["platform"],
): UpdateConfig | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== UPDATE_CONFIG_KEYS.length ||
    !UPDATE_CONFIG_KEYS.every((key) => Object.hasOwn(value, key)) ||
    value.schema_version !== UPDATE_SCHEMA_VERSION ||
    !isAppId(value.app_id) ||
    !isPlatform(value.platform) ||
    typeof value.enabled !== "boolean" ||
    !isValidSemVer(value.latest_version) ||
    !isValidSemVer(value.min_supported_version) ||
    typeof value.force_update !== "boolean" ||
    typeof value.rollout !== "number" ||
    !Number.isInteger(value.rollout) ||
    value.rollout < 0 ||
    value.rollout > 100 ||
    !isSafeExternalUrl(value.download_url) ||
    !isSafeExternalUrl(value.release_notes_url) ||
    (expectedAppId !== undefined && value.app_id !== expectedAppId) ||
    (expectedPlatform !== undefined && value.platform !== expectedPlatform) ||
    compareSemVer(value.min_supported_version, value.latest_version) > 0
  ) {
    return null;
  }

  return {
    schema_version: 1,
    app_id: value.app_id,
    platform: value.platform,
    enabled: value.enabled,
    latest_version: value.latest_version,
    min_supported_version: value.min_supported_version,
    force_update: value.force_update,
    rollout: value.rollout,
    download_url: value.download_url,
    release_notes_url: value.release_notes_url,
  };
}

export function decideUpdate(
  currentVersion: string,
  installId: string,
  config: UpdateConfig,
): UpdateDecision {
  if (!isValidSemVer(currentVersion) || !isUuidV4(installId)) {
    return none("invalid_config");
  }
  if (!config.enabled) {
    return none("disabled");
  }
  if (compareSemVer(currentVersion, config.latest_version) >= 0) {
    return none("up_to_date");
  }
  if (
    compareSemVer(currentVersion, config.min_supported_version) < 0 ||
    config.force_update
  ) {
    return { kind: "required", config };
  }
  if (rolloutBucket(installId, config.latest_version) < config.rollout) {
    return { kind: "optional", config };
  }
  return none("rollout");
}

/** Stable FNV-1a bucket over the specified install_id + latest_version value. */
export function rolloutBucket(
  installId: string,
  latestVersion: string,
): number {
  const bytes = new TextEncoder().encode(`${installId}${latestVersion}`);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

export async function runUpdateHostHooks(
  decision: UpdateDecision,
  hooks: UpdateHostHooks,
  logger?: DebugLogger,
): Promise<void> {
  try {
    if (decision.kind === "optional") {
      await hooks.onOptionalUpdate?.(decision);
    } else if (decision.kind === "required") {
      await hooks.onRequiredUpdate?.(decision);
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

export function buildUpdateUrl(
  baseUrl: string,
  appId: string,
  platform: UpdateConfig["platform"],
): string | null {
  if (!isSafeExternalUrl(baseUrl) || !isAppId(appId) || !isPlatform(platform)) {
    return null;
  }
  const parsedBase = new URL(baseUrl);
  if (parsedBase.search !== "" || parsedBase.hash !== "") {
    return null;
  }
  if (!parsedBase.pathname.endsWith("/")) {
    parsedBase.pathname = `${parsedBase.pathname}/`;
  }
  const url = new URL(
    `${appId}/${platform}.json`,
    parsedBase.toString(),
  ).toString();
  return isSafeExternalUrl(url) ? url : null;
}

function isValidCheckerConfig(config: UpdateCheckerConfig): boolean {
  return (
    isSafeExternalUrl(config.baseUrl) &&
    isAppId(config.appId) &&
    isPlatform(config.platform) &&
    isValidSemVer(config.currentVersion) &&
    isUuidV4(config.installId)
  );
}

function normalizeTimeout(value: number | undefined): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 30_000
    ? value
    : DEFAULT_UPDATE_TIMEOUT_MS;
}

function none(reason: NoUpdateDecision["reason"]): NoUpdateDecision {
  return { kind: "none", reason };
}

const defaultFetch: UpdateFetch = async (url, init) => {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("fetch_unavailable");
  }
  return globalThis.fetch(url, {
    method: init.method,
    headers: init.headers,
    signal: init.signal,
    credentials: "omit",
    redirect: "error",
  });
};

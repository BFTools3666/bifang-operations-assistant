import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { isPersistedIdentity } from "./identity.js";
import { isAppId } from "./validation.js";
import type {
  IdentityReadOrCreateResult,
  IdentityStorage,
  PersistedInstallIdentity,
} from "./types.js";

const DEFAULT_FILE_NAME = "telemetry-installation.json";
const MAX_IDENTITY_FILE_BYTES = 4_096;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface NodeFileIdentityStorageOptions {
  /**
   * Optional stable application identifier used to namespace every file.
   * Supplying it prevents two tools from sharing an install identity or daily
   * activity gate even if a host accidentally gives them the same directory.
   */
  appId?: string;
  fileName?: string;
}

/**
 * A small, atomic JSON store for an install identifier. The caller must pass
 * its own application-specific AppConfig directory; this class never guesses
 * a system or user directory.
 */
export class NodeFileIdentityStorage implements IdentityStorage {
  readonly #appConfigDirectory: string;
  readonly #filePath: string;
  readonly #recoveryFilePath: string;
  readonly #activityMarkerPrefix: string;

  constructor(
    appConfigDirectory: string,
    options: NodeFileIdentityStorageOptions = {},
  ) {
    if (!isAbsolute(appConfigDirectory)) {
      throw new TypeError("appConfigDirectory must be an absolute path");
    }

    const directory = resolve(appConfigDirectory);
    if (directory === parse(directory).root) {
      throw new TypeError("appConfigDirectory must not be a filesystem root");
    }

    if (options.appId !== undefined && !isAppId(options.appId)) {
      throw new TypeError("appId must be a valid application identifier");
    }

    const baseFileName = options.fileName ?? DEFAULT_FILE_NAME;
    if (
      !SAFE_FILE_NAME.test(baseFileName) ||
      baseFileName === "." ||
      baseFileName === ".."
    ) {
      throw new TypeError("fileName must be a plain safe file name");
    }

    const fileName =
      options.appId === undefined
        ? baseFileName
        : `${options.appId}.${baseFileName}`;
    if (!SAFE_FILE_NAME.test(fileName)) {
      throw new TypeError("appId and fileName produce an unsafe file name");
    }

    const filePath = resolve(join(directory, fileName));
    if (dirname(filePath) !== directory) {
      throw new TypeError(
        "identity file must remain inside appConfigDirectory",
      );
    }

    this.#appConfigDirectory = directory;
    this.#filePath = filePath;
    this.#recoveryFilePath = `${filePath}.recovery-v1`;
    this.#activityMarkerPrefix = `.${fileName}.daily-active-`;
  }

  get filePath(): string {
    return this.#filePath;
  }

  async read(): Promise<unknown | null> {
    const primary = await this.#readPath(this.#filePath);
    if (isPersistedIdentity(primary)) {
      return primary;
    }

    const recovery = await this.#readPath(this.#recoveryFilePath);
    return isPersistedIdentity(recovery) ? recovery : primary;
  }

  async #readPath(filePath: string): Promise<unknown | null> {
    try {
      const metadata = await stat(filePath);
      if (!metadata.isFile() || metadata.size > MAX_IDENTITY_FILE_BYTES) {
        return null;
      }
      const contents = await readFile(filePath, "utf8");
      return JSON.parse(contents) as unknown;
    } catch {
      // A missing, unreadable, or corrupt marker is treated as a fresh install.
      return null;
    }
  }

  async write(record: PersistedInstallIdentity): Promise<void> {
    await mkdir(this.#appConfigDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = this.#temporaryPath();

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#filePath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async claimActivityDay(day: string): Promise<boolean> {
    if (!isActivityDay(day)) {
      throw new TypeError("day must be a valid YYYY-MM-DD date");
    }

    await mkdir(this.#appConfigDirectory, { recursive: true, mode: 0o700 });
    const markerPath = join(
      this.#appConfigDirectory,
      `${this.#activityMarkerPrefix}${day}`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(markerPath, "wx", 0o600);
      await handle.writeFile(`${day}\n`, "utf8");
      await handle.sync();
      return true;
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        return false;
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async readOrCreate(
    candidate: PersistedInstallIdentity,
  ): Promise<IdentityReadOrCreateResult> {
    await mkdir(this.#appConfigDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = this.#temporaryPath();
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(candidate)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;

      try {
        await link(temporaryPath, this.#filePath);
        return { record: { ...candidate }, created: true };
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) {
          throw error;
        }
      }

      const existing = await this.read();
      if (isPersistedIdentity(existing)) {
        return { record: existing, created: false };
      }

      // Keep an invalid primary untouched. A fixed sidecar lets every process
      // atomically select and reuse one recovery identity without a racy
      // inspect-then-replace operation on the primary path.
      try {
        await link(temporaryPath, this.#recoveryFilePath);
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) {
          throw error;
        }
      }

      // Re-read both paths after the CAS. A concurrently repaired valid primary
      // takes precedence; otherwise every contender observes the sidecar winner.
      const recovered = await this.read();
      if (isPersistedIdentity(recovered)) {
        return { record: recovered, created: false };
      }
      throw new Error("identity_recovery_invalid");
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  #temporaryPath(): string {
    return join(
      this.#appConfigDirectory,
      `.${DEFAULT_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
    );
  }
}

function hasErrorCode(error: unknown, expected: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === expected
  );
}

function isActivityDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(instant.getTime()) &&
    instant.toISOString().slice(0, 10) === value
  );
}

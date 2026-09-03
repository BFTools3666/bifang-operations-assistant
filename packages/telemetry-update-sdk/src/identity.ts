import type {
  DebugLogger,
  IdentityStorage,
  InstallIdentityState,
  PersistedInstallIdentity,
} from "./types.js";
import { isIsoDate, isRecord, isUuidV4 } from "./validation.js";

const storageInitializationQueues = new WeakMap<object, Promise<void>>();

export interface InstallIdentityOptions {
  logger?: DebugLogger;
  now?: () => Date;
  uuid?: () => string;
}

export class InstallIdentity {
  readonly #storage: IdentityStorage;
  readonly #logger: DebugLogger | undefined;
  readonly #now: () => Date;
  readonly #uuid: () => string;
  #initialization: Promise<InstallIdentityState> | undefined;

  constructor(storage: IdentityStorage, options: InstallIdentityOptions = {}) {
    this.#storage = storage;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#uuid = options.uuid ?? defaultUuid;
  }

  initialize(): Promise<InstallIdentityState> {
    this.#initialization ??= runSerializedForStorage(this.#storage, async () =>
      this.#initializeOnce(),
    );
    return this.#initialization;
  }

  async #initializeOnce(): Promise<InstallIdentityState> {
    const stored = await this.#readSafely();
    const sessionId = this.#safeUuid();
    if (isPersistedIdentity(stored)) {
      return {
        installId: stored.install_id,
        sessionId,
        isFirstInstall: false,
      };
    }

    const record: PersistedInstallIdentity = {
      schema_version: 1,
      installed: true,
      install_id: this.#safeUuid(),
      created_at: this.#safeNow(),
    };

    if (typeof this.#storage.readOrCreate === "function") {
      try {
        const result = await this.#storage.readOrCreate(record);
        if (isPersistedIdentity(result.record)) {
          return {
            installId: result.record.install_id,
            sessionId,
            isFirstInstall:
              result.created === true &&
              result.record.install_id === record.install_id,
          };
        }
        this.#debug("identity_atomic_result_invalid", result.record);
      } catch (error) {
        this.#debug("identity_atomic_create_failed", error);
        const winner = await this.#readSafely();
        if (isPersistedIdentity(winner)) {
          return {
            installId: winner.install_id,
            sessionId,
            isFirstInstall: false,
          };
        }
      }

      return {
        installId: record.install_id,
        sessionId,
        isFirstInstall: false,
      };
    }

    let persisted = false;
    try {
      await this.#storage.write(record);
      persisted = true;
    } catch (error) {
      this.#debug("identity_write_failed", error);
    }

    return {
      installId: record.install_id,
      sessionId,
      isFirstInstall: persisted,
    };
  }

  async #readSafely(): Promise<unknown | null> {
    try {
      return await this.#storage.read();
    } catch (error) {
      this.#debug("identity_read_failed", error);
      return null;
    }
  }

  #safeUuid(): string {
    try {
      const value = this.#uuid();
      return isUuidV4(value) ? value : defaultUuid();
    } catch {
      return defaultUuid();
    }
  }

  #safeNow(): string {
    try {
      const value = this.#now().toISOString();
      return isIsoDate(value) ? value : new Date().toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  #debug(message: string, error: unknown): void {
    try {
      this.#logger?.debug(message, {
        error: error instanceof Error ? error.name : "unknown",
      });
    } catch {
      // Debug logging must never affect the host application.
    }
  }
}

async function runSerializedForStorage<T>(
  storage: IdentityStorage,
  initialize: () => Promise<T>,
): Promise<T> {
  if (
    (typeof storage !== "object" && typeof storage !== "function") ||
    storage === null
  ) {
    return initialize();
  }

  const key = storage as object;
  const previous = storageInitializationQueues.get(key) ?? Promise.resolve();
  const current = previous.then(initialize);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  storageInitializationQueues.set(key, tail);

  try {
    return await current;
  } finally {
    if (storageInitializationQueues.get(key) === tail) {
      storageInitializationQueues.delete(key);
    }
  }
}

export class MemoryIdentityStorage implements IdentityStorage {
  #record: unknown | null;

  constructor(initialRecord: unknown | null = null) {
    this.#record = initialRecord;
  }

  async read(): Promise<unknown | null> {
    return this.#record;
  }

  async write(record: PersistedInstallIdentity): Promise<void> {
    this.#record = { ...record };
  }
}

export function isPersistedIdentity(
  value: unknown,
): value is PersistedInstallIdentity {
  if (!isRecord(value)) {
    return false;
  }
  const expectedKeys = [
    "schema_version",
    "installed",
    "install_id",
    "created_at",
  ];
  return (
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key)) &&
    value.schema_version === 1 &&
    value.installed === true &&
    isUuidV4(value.install_id) &&
    isIsoDate(value.created_at)
  );
}

function defaultUuid(): string {
  return globalThis.crypto.randomUUID();
}

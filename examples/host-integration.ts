/**
 * Framework-neutral integration fragment. The host supplies AppConfig storage,
 * UI callbacks, external-URL opening, and process exit behavior.
 * Startup order:
 *   const services = await initializePublicServices(options);
 *   await host.completeStartupAndShowMainWindow();
 *   services.checkForUpdatesInBackground();
 */
import {
  ApplicationVersionChecker,
  TelemetryClient,
  isSafeExternalUrl,
  runApplicationVersionHostHooks,
  type Architecture,
  type AvailableApplicationVersionDecision,
  type OptionalApplicationVersionDecision,
  type Platform,
  type RequiredApplicationVersionDecision,
  type StoppedApplicationVersionDecision,
} from "@bifang/telemetry-update-sdk";
import { NodeFileIdentityStorage } from "@bifang/telemetry-update-sdk/node";

export interface ReleaseConfig {
  /** A stable identifier unique to this tool, for example bifang-tools-pdf. */
  APP_ID: string;
  APP_VERSION: string;
  /** Exact single-v1 base: https://<host>/tools/version-control/v1. */
  APPLICATION_VERSION_BASE_URL: string;
  /** Platform/architecture-specific application-version API code. */
  APPLICATION_VERSION_CODE: string;
  /** Runtime-only credential with versions:check for this exact code. */
  APPLICATION_VERSION_APP_KEY: string;
  APPLICATION_VERSION_APP_SECRET: string;
  /** This tool's dedicated telemetry function route. */
  TELEMETRY_ENDPOINT: string;
  telemetry_enabled: boolean;
  update_check_enabled: boolean;
}

export interface HostUpdateUi {
  /** Render API prompt content as untrusted plain text, never HTML. */
  showOptionalUpdate(
    decision: Readonly<OptionalApplicationVersionDecision>,
    actions: {
      updateNow: () => Promise<void>;
      remindLater: () => void;
    },
  ): void | Promise<void>;
  /** Render API prompt content as untrusted plain text, never HTML. */
  showRequiredUpdate(
    decision: Readonly<RequiredApplicationVersionDecision>,
    actions: {
      updateNow: () => Promise<void>;
      exit: () => Promise<void>;
    },
  ): void | Promise<void>;
  /** A paused release stream is not an instruction to exit the application. */
  onUpdateStopped?(
    decision: Readonly<StoppedApplicationVersionDecision>,
  ): void | Promise<void>;
  openExternal(url: string): void | Promise<void>;
  exitApplication(): void | Promise<void>;
}

export interface InitializeOptions {
  release: ReleaseConfig;
  platform: Platform;
  arch: Architecture;
  /**
   * An absolute, application-specific configuration directory. Never reuse
   * another tool's directory; the appId namespace is a second safety boundary.
   */
  appConfigDirectory: string;
  ui: HostUpdateUi;
}

export interface PublicServices {
  telemetry: TelemetryClient;
  /** Call only after the application has completed startup and shown its UI. */
  checkForUpdatesInBackground(): void;
}

export async function initializePublicServices(
  options: InitializeOptions,
): Promise<PublicServices> {
  const { release } = options;
  const telemetry = await TelemetryClient.init({
    appId: release.APP_ID,
    appVersion: release.APP_VERSION,
    platform: options.platform,
    arch: options.arch,
    endpoint: release.TELEMETRY_ENDPOINT,
    enabled: release.telemetry_enabled,
    identityStorage: new NodeFileIdentityStorage(options.appConfigDirectory, {
      appId: release.APP_ID,
    }),
  });

  return {
    telemetry,
    checkForUpdatesInBackground() {
      setTimeout(() => {
        void checkForUpdates(options).catch(() => undefined);
      }, 0);
    },
  };
}

async function checkForUpdates(options: InitializeOptions): Promise<void> {
  const { release } = options;
  const checker = new ApplicationVersionChecker({
    baseUrl: release.APPLICATION_VERSION_BASE_URL,
    code: release.APPLICATION_VERSION_CODE,
    currentVersion: release.APP_VERSION,
    appKey: release.APPLICATION_VERSION_APP_KEY,
    appSecret: release.APPLICATION_VERSION_APP_SECRET,
    enabled: release.update_check_enabled,
  });
  const updateDecision = await checker.check();

  await runApplicationVersionHostHooks(updateDecision, {
    onOptionalUpdate: async (decision) => {
      await options.ui.showOptionalUpdate(decision, {
        updateNow: () => openDownload(decision, options.ui),
        remindLater: () => undefined,
      });
    },
    onRequiredUpdate: async (decision) => {
      await options.ui.showRequiredUpdate(decision, {
        updateNow: () => openDownload(decision, options.ui),
        exit: async () => {
          await options.ui.exitApplication();
        },
      });
    },
    onStoppedUpdate: async (decision) => {
      await options.ui.onUpdateStopped?.(decision);
    },
  });
}

async function openDownload(
  decision: AvailableApplicationVersionDecision,
  ui: HostUpdateUi,
): Promise<void> {
  const url = decision.data.downloadUrl;
  if (!isSafeExternalUrl(url)) return;

  await ui.openExternal(url);
}

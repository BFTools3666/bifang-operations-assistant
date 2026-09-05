/**
 * Framework-neutral integration fragment. The host supplies AppConfig storage,
 * UI callbacks, external-URL opening, and process exit behavior.
 * Startup order:
 *   const services = await initializePublicServices(options);
 *   await host.completeStartupAndShowMainWindow();
 *   services.checkForUpdatesInBackground();
 */
import {
  TelemetryClient,
  UpdateChecker,
  isSafeExternalUrl,
  runUpdateHostHooks,
  type Architecture,
  type AvailableUpdateDecision,
  type OptionalUpdateDecision,
  type Platform,
  type RequiredUpdateDecision,
} from "@bifang/telemetry-update-sdk";
import { NodeFileIdentityStorage } from "@bifang/telemetry-update-sdk/node";

export interface ReleaseConfig {
  /** A stable identifier unique to this tool, for example bifang-tools-pdf. */
  APP_ID: string;
  APP_VERSION: string;
  /** This tool's update base; UpdateChecker appends APP_ID/platform.json. */
  UPDATE_BASE_URL: string;
  /** This tool's dedicated telemetry function route. */
  TELEMETRY_ENDPOINT: string;
  telemetry_enabled: boolean;
  update_check_enabled: boolean;
}

export interface HostUpdateUi {
  /** Render manifest title/message as untrusted plain text, never HTML. */
  showOptionalUpdate(
    decision: Readonly<OptionalUpdateDecision>,
    actions: {
      updateNow: () => Promise<void>;
      remindLater: () => void;
    },
  ): void | Promise<void>;
  /** Render manifest title/message as untrusted plain text, never HTML. */
  showRequiredUpdate(
    decision: Readonly<RequiredUpdateDecision>,
    actions: {
      updateNow: () => Promise<void>;
      exit: () => Promise<void>;
    },
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
        void checkForUpdates(options, telemetry).catch(() => undefined);
      }, 0);
    },
  };
}

async function checkForUpdates(
  options: InitializeOptions,
  telemetry: TelemetryClient,
): Promise<void> {
  const { release } = options;
  const checker = new UpdateChecker({
    baseUrl: release.UPDATE_BASE_URL,
    appId: release.APP_ID,
    platform: options.platform,
    currentVersion: release.APP_VERSION,
    installId: telemetry.installId,
    enabled: release.update_check_enabled,
  });
  const updateDecision = await checker.check();

  await runUpdateHostHooks(updateDecision, {
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
  });
}

async function openDownload(
  decision: AvailableUpdateDecision,
  ui: HostUpdateUi,
): Promise<void> {
  const url = decision.config.download_url;
  if (!isSafeExternalUrl(url)) return;

  await ui.openExternal(url);
}

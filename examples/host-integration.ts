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
  APP_ID: string;
  APP_VERSION: string;
  CHANNEL?: string;
  UPDATE_BASE_URL: string;
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
  /** An absolute directory chosen by the host for this app's configuration. */
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
    channel: release.CHANNEL,
    endpoint: release.TELEMETRY_ENDPOINT,
    enabled: release.telemetry_enabled,
    identityStorage: new NodeFileIdentityStorage(options.appConfigDirectory),
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
        updateNow: () => openDownload(telemetry, decision, options.ui),
        remindLater: () => undefined,
      });
      telemetry.trackUpdatePromptShown(decision);
    },
    onRequiredUpdate: async (decision) => {
      await options.ui.showRequiredUpdate(decision, {
        updateNow: () => openDownload(telemetry, decision, options.ui),
        exit: async () => {
          await options.ui.exitApplication();
        },
      });
      telemetry.trackUpdatePromptShown(decision);
    },
  });
}

async function openDownload(
  telemetry: TelemetryClient,
  decision: AvailableUpdateDecision,
  ui: HostUpdateUi,
): Promise<void> {
  const url = decision.config.download_url;
  if (!isSafeExternalUrl(url)) return;

  telemetry.trackUpdateClicked(decision);
  await ui.openExternal(url);
}

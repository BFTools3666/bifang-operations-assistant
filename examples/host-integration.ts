/**
 * Framework-neutral integration fragment. The host supplies AppConfig storage,
 * UI callbacks, external-URL opening, and process exit behavior.
 * Startup order:
 *   const services = await initializePublicServices(options);
 *   await host.completeStartupAndShowMainWindow();
 *   services.checkForUpdatesInBackground();
 */
import {
  ClientUpdateService,
  TelemetryClient,
  type Architecture,
  type ClientUpdateRequest,
  type ClientUpdateResult,
  type Platform,
} from "@bifang/telemetry-update-sdk";
import { NodeFileIdentityStorage } from "@bifang/telemetry-update-sdk/node";

export interface ReleaseConfig {
  /** A stable identifier unique to this tool, for example bifang-tools-pdf. */
  APP_ID: string;
  /** Actual application release version from the host's single version source.
   * Shared by telemetry app_version and version checks; never the SDK version
   * or the onboarding Profile snapshot.
   */
  APP_VERSION: string;
  /** Supplied at runtime by the trusted host, never stored in a Profile. */
  CLIENT_UPDATE_TOKEN: string;
  /** This tool's dedicated telemetry function route. */
  TELEMETRY_ENDPOINT: string;
  telemetry_enabled: boolean;
  update_check_enabled: boolean;
}

export interface HostUpdateUi {
  /** The host renders untrusted notes as text and handles every decision. */
  onUpdateResult(result: ClientUpdateResult): void | Promise<void>;
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
  /** Real process platform, persisted random UUID and implemented capabilities. */
  updateRequest: Omit<ClientUpdateRequest, "current_version" | "trigger">;
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
  if (!release.update_check_enabled) return;
  const checker = new ClientUpdateService({
    appId: release.APP_ID,
    token: release.CLIENT_UPDATE_TOKEN,
  });
  const result = await checker.check({
    ...options.updateRequest,
    current_version: release.APP_VERSION,
    trigger: "startup",
  });
  await options.ui.onUpdateResult(result);
}

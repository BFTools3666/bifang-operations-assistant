import type { TelemetryEvent, TelemetryTransport } from "./types.js";

export class FetchTelemetryTransport implements TelemetryTransport {
  async send(
    endpoint: string,
    event: Readonly<TelemetryEvent>,
    signal: AbortSignal,
  ): Promise<void> {
    if (typeof globalThis.fetch !== "function") {
      throw new Error("fetch_unavailable");
    }

    const response = await globalThis.fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
      signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });

    if (!response.ok) {
      throw new Error("telemetry_rejected");
    }
  }
}

import type { CdpEventListener } from "./cdp-client.js";
import { CdpClient } from "./cdp-client.js";

interface RuntimeEvaluation<T> {
  exceptionDetails?: { text?: string };
  result: { value?: T };
}

export interface BrowserDomSnapshot {
  documents: unknown[];
  layout: unknown;
  strings: string[];
}

/**
 * A target-bound CDP facade shared by the streamed UI and future agent tools.
 * Keeping the raw browser websocket and session id inside the worker prevents
 * callers from accidentally exposing a profile's privileged CDP endpoint.
 */
export class BrowserCdpSession {
  constructor(
    readonly client: CdpClient,
    readonly sessionId: string,
  ) {}

  command<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return this.client.request<T>(method, params, this.sessionId);
  }

  on(method: string, listener: CdpEventListener): () => void {
    return this.client.on(method, (params, sessionId) => {
      if (sessionId === this.sessionId) listener(params, sessionId);
    });
  }

  async evaluate<T>(expression: string): Promise<T | undefined> {
    const result = await this.command<RuntimeEvaluation<T>>(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text ?? "Browser evaluation failed.",
      );
    }
    return result.result.value;
  }

  captureScreenshot(
    options: {
      format?: "jpeg" | "png";
      quality?: number;
    } = {},
  ): Promise<{ data: string }> {
    return this.command("Page.captureScreenshot", {
      format: options.format ?? "jpeg",
      quality: options.quality ?? 78,
      fromSurface: true,
      captureBeyondViewport: false,
    });
  }

  captureDomSnapshot(): Promise<BrowserDomSnapshot> {
    return this.command("DOMSnapshot.captureSnapshot", {
      computedStyles: [],
      includeDOMRects: true,
      includePaintOrder: true,
    });
  }
}

import type { CodeAttachment, ExplorerFile } from "@cantrip/protocol";

import {
  desktopExplorerWindowChannelName,
  isDesktopExplorerWindowResponse,
  type DesktopExplorerWindowContext,
  type DesktopExplorerWindowRequest,
} from "@/lib/desktop-explorer-window-protocol";

type PendingRequest = {
  reject(error: Error): void;
  resolve(value: Blob | ExplorerFile): void;
  timeout: ReturnType<typeof setTimeout>;
};

export interface DesktopExplorerWindowClientCallbacks {
  onContext(context: DesktopExplorerWindowContext): void;
  onEditor(attachment: CodeAttachment, preparedAtMs: number): void;
  onEditorConfigured(configuredAtMs: number): void;
  onEditorError(error: string): void;
  onLaunchError(error: string): void;
}

export class DesktopExplorerWindowClient {
  readonly #callbacks: DesktopExplorerWindowClientCallbacks;
  readonly #channel: BroadcastChannel;
  readonly #launchId: string;
  readonly #pending = new Map<string, PendingRequest>();
  #contextReceived = false;
  #disposed = false;
  #launchRetry: ReturnType<typeof setInterval> | null = null;
  #launchTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    launchId: string,
    callbacks: DesktopExplorerWindowClientCallbacks,
  ) {
    this.#launchId = launchId;
    this.#callbacks = callbacks;
    this.#channel = new BroadcastChannel(
      desktopExplorerWindowChannelName(launchId),
    );
    this.#channel.addEventListener("message", this.#onMessage);
  }

  start(): void {
    if (this.#disposed) return;
    this.#requestLaunch();
    this.#launchRetry = setInterval(() => this.#requestLaunch(), 100);
    this.#launchTimeout = setTimeout(() => {
      if (this.#launchRetry) clearInterval(this.#launchRetry);
      this.#launchRetry = null;
      this.#callbacks.onLaunchError(
        "The main Cantrip window did not provide this editor session.",
      );
    }, 5_000);
  }

  readFile(): Promise<ExplorerFile> {
    return this.#request<ExplorerFile>({ type: "file.read" });
  }

  readMedia(): Promise<Blob> {
    return this.#request<Blob>({ type: "media.read" });
  }

  saveFile(content: string, version: string): Promise<ExplorerFile> {
    return this.#request<ExplorerFile>({ content, type: "file.save", version });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#launchRetry) clearInterval(this.#launchRetry);
    if (this.#launchTimeout) clearTimeout(this.#launchTimeout);
    this.#channel.removeEventListener("message", this.#onMessage);
    this.#channel.close();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("The editor window closed."));
    }
    this.#pending.clear();
  }

  readonly #onMessage = (event: MessageEvent<unknown>) => {
    const response = event.data;
    if (
      !isDesktopExplorerWindowResponse(response) ||
      response.launchId !== this.#launchId
    ) {
      return;
    }
    if (response.type === "launch.ready") {
      if (this.#contextReceived) return;
      this.#contextReceived = true;
      if (this.#launchRetry) clearInterval(this.#launchRetry);
      this.#launchRetry = null;
      if (this.#launchTimeout) clearTimeout(this.#launchTimeout);
      this.#launchTimeout = null;
      this.#callbacks.onContext(response.context);
      return;
    }
    if (response.type === "editor.ready") {
      this.#callbacks.onEditor(response.attachment, response.preparedAtMs);
      return;
    }
    if (response.type === "editor.configured") {
      this.#callbacks.onEditorConfigured(response.configuredAtMs);
      return;
    }
    if (response.type === "editor.failed") {
      this.#callbacks.onEditorError(response.error);
      return;
    }
    const pending = this.#pending.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(response.requestId);
    if (response.type === "request.failed") {
      pending.reject(new Error(response.error));
    } else if (response.type === "media.result") {
      pending.resolve(response.blob);
    } else {
      pending.resolve(response.file);
    }
  };

  #requestLaunch(): void {
    if (this.#disposed) return;
    this.#channel.postMessage({
      launchId: this.#launchId,
      type: "launch.request",
    } satisfies DesktopExplorerWindowRequest);
  }

  #request<T extends Blob | ExplorerFile>(
    request:
      | { type: "file.read" | "media.read" }
      | { content: string; type: "file.save"; version: string },
  ): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(new Error("The editor window is closed."));
    }
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error("The main Cantrip window did not answer in time."));
      }, 15_000);
      this.#pending.set(requestId, {
        reject,
        resolve: (value) => resolve(value as T),
        timeout,
      });
      this.#channel.postMessage({
        ...request,
        launchId: this.#launchId,
        requestId,
      } satisfies DesktopExplorerWindowRequest);
    });
  }
}

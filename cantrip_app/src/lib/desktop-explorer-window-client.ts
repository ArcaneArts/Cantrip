import type { CodeAttachment, ExplorerFile } from "@cantrip/protocol";

import {
  desktopExplorerWindowChannelName,
  isDesktopExplorerWindowResponse,
  type DesktopExplorerWindowContext,
  type DesktopExplorerWindowRequest,
  type DesktopExplorerWindowResponse,
} from "@/lib/desktop-explorer-window-protocol";

type PendingRequest = {
  reject(error: Error): void;
  resolve(value: Blob | ExplorerFile): void;
  timeout: ReturnType<typeof setTimeout>;
};

export interface DesktopExplorerWindowClientCallbacks {
  onContext(context: DesktopExplorerWindowContext): void;
  onEditorEndpoint(attachment: CodeAttachment, preparedAtMs: number): void;
  onEditorError(
    error: string,
    stage: Extract<
      DesktopExplorerWindowResponse,
      { type: "editor.failed" }
    >["stage"],
  ): void;
  onEditorReady(configuredAtMs: number): void;
  onLaunchError(error: string): void;
}

export class DesktopExplorerWindowClient {
  readonly #callbacks: DesktopExplorerWindowClientCallbacks;
  readonly #channel: BroadcastChannel;
  readonly #launchId: string;
  readonly #pending = new Map<string, PendingRequest>();
  #configuredSignature: string | null = null;
  #contextReceived = false;
  #contextSignature: string | null = null;
  #disposed = false;
  #endpointSignature: string | null = null;
  #launchRetry: ReturnType<typeof setInterval> | null = null;
  #launchTimeout: ReturnType<typeof setTimeout> | null = null;
  #workbenchNonce: string | null = null;

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

  editorWorkbenchReady(nonce: string): void {
    if (this.#disposed) return;
    this.#workbenchNonce = nonce;
    this.#configuredSignature = null;
    this.#channel.postMessage({
      launchId: this.#launchId,
      nonce,
      type: "editor.workbench-ready",
    } satisfies DesktopExplorerWindowRequest);
  }

  editorWorkbenchMounted(nonce: string): void {
    if (this.#disposed) return;
    this.#workbenchNonce = nonce;
    this.#configuredSignature = null;
    this.#channel.postMessage({
      launchId: this.#launchId,
      nonce,
      type: "editor.workbench-mounted",
    } satisfies DesktopExplorerWindowRequest);
  }

  editorWorkbenchFailed(
    nonce: string,
    error: string,
    stage: "frame" | "workbench",
  ): void {
    if (this.#disposed) return;
    this.#channel.postMessage({
      error,
      launchId: this.#launchId,
      nonce,
      stage,
      type: "editor.workbench-failed",
    } satisfies DesktopExplorerWindowRequest);
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
      if (!this.#contextReceived) {
        this.#contextReceived = true;
        if (this.#launchRetry) clearInterval(this.#launchRetry);
        this.#launchRetry = null;
        if (this.#launchTimeout) clearTimeout(this.#launchTimeout);
        this.#launchTimeout = null;
      }
      const signature = `${response.context.requestedAtMs}\0${response.context.path}`;
      if (signature === this.#contextSignature) return;
      this.#contextSignature = signature;
      this.#configuredSignature = null;
      this.#callbacks.onContext(response.context);
      return;
    }
    if (response.type === "editor.endpoint-ready") {
      const signature = `${response.attachment.attachmentId}\0${response.attachment.sessionId}\0${response.attachment.url}\0${response.preparedAtMs}`;
      if (signature === this.#endpointSignature) return;
      this.#endpointSignature = signature;
      this.#callbacks.onEditorEndpoint(
        response.attachment,
        response.preparedAtMs,
      );
      return;
    }
    if (response.type === "editor.ready") {
      if (
        response.nonce !== this.#workbenchNonce ||
        !this.#contextSignature ||
        this.#contextSignature !== `${response.requestedAtMs}\0${response.path}`
      ) {
        return;
      }
      const signature = `${response.requestedAtMs}\0${response.path}\0${response.configuredAtMs}`;
      if (signature === this.#configuredSignature) return;
      this.#configuredSignature = signature;
      this.#callbacks.onEditorReady(response.configuredAtMs);
      return;
    }
    if (response.type === "editor.failed") {
      this.#callbacks.onEditorError(response.error, response.stage);
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

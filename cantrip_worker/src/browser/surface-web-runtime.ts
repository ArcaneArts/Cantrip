import {
  browserPointerGesture,
  type BrowserPointerGesture,
} from "./pointer-gesture.js";
import { randomBytes } from "node:crypto";
import type { CantripMcpBinding } from "@cantrip/protocol";
import type { WorkerWebServiceOptions } from "../web/service.js";
import type {
  WebSessionOpenOptions,
  WebSessionState,
  WebSessionSnapshot,
} from "../managed-runtimes/playwright.js";
import type { BrowserCdpSession } from "./browser-session.js";

type Runtime = NonNullable<WorkerWebServiceOptions["sessionRuntime"]>;
type Record_ = {
  owner: string;
  chat: string;
  surface: string;
  cdp: BrowserCdpSession;
  generation: number;
  elements: Map<string, number>;
  key: string;
  busy: boolean;
  unsubscribe: () => void;
};
const opaque = (prefix: string) =>
  `${prefix}_${randomBytes(24).toString("base64url")}`;

/** Exact Browser targets borrow the visible page; untargeted research stays isolated. */
export class BrowserSurfaceWebRuntime implements Runtime {
  private readonly records = new Map<string, Record_>();
  private readonly operations = new Set<{
    binding: CantripMcpBinding;
    controller: AbortController;
  }>();

  cancelBinding(binding: CantripMcpBinding): void {
    for (const operation of this.operations) {
      const active = operation.binding;
      if (
        active.bindingId === binding.bindingId &&
        active.executionLaneId === binding.executionLaneId
      ) {
        operation.controller.abort(
          new Error("Browser operation stopped with its agent turn."),
        );
      }
    }
  }
  constructor(
    private readonly fallback: Runtime,
    private readonly lookup: (
      surface: string,
      owner: string,
    ) => BrowserCdpSession | null,
  ) {}

  async openSession(
    binding: CantripMcpBinding,
    url: string,
    options: WebSessionOpenOptions = {},
  ): Promise<WebSessionState> {
    if (!options.browserTarget && !this.records.has(options.sessionId ?? ""))
      return this.fallback.openSession(binding, url, options);
    const target = new URL(url);
    if (!["http:", "https:"].includes(target.protocol))
      throw new Error("Browser navigation requires HTTP or HTTPS.");
    await options.beforeNavigation?.(target);
    let id = options.sessionId;
    if (!id) {
      const surface = options.browserTarget!.surfaceId;
      const cdp = this.lookup(surface, binding.ownerId);
      if (!cdp)
        throw new Error(
          "The selected Browser surface is not open. Open that browser in Cantrip, then retry.",
        );
      id = opaque("wss");
      this.records.set(id, {
        owner: binding.ownerId,
        chat: binding.chatId,
        surface,
        cdp,
        generation: 1,
        elements: new Map(),
        key: opaque("cantrip"),
        busy: false,
        unsubscribe: cdp.client.onClose(() => this.records.delete(id!)),
      });
    }
    const record = this.record(binding, id);
    try {
      record.cdp.onAgentStart?.(record.chat);
    } catch {
      /* Presentation is independent of navigation. */
    }
    return this.exclusive(binding, record, async () => {
      this.invalidate(record);
      await this.navigate(record, target.href);
      return this.state(id!, record);
    });
  }

  async snapshotSession(
    binding: CantripMcpBinding,
    id: string,
    maxChars: number,
  ): Promise<WebSessionSnapshot> {
    if (!this.records.has(id))
      return this.fallback.snapshotSession(binding, id, maxChars);
    const record = this.record(binding, id);
    return this.exclusive(binding, record, async () => {
      this.invalidate(record);
      const key = JSON.stringify(record.key);
      const result = await record.cdp.evaluate<{
        text: string;
        elements: string[];
      }>(`(() => {
        const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')).filter(n => n.getClientRects().length).slice(0,100);
        globalThis[${key}] = nodes;
        return { text: (document.body?.innerText || '').slice(0,${Math.max(1, maxChars)}), elements: nodes.map(n => ((n.getAttribute('aria-label') || n.innerText || n.getAttribute('placeholder') || n.getAttribute('name') || n.tagName)).slice(0,500)) };
      })()`);
      const elements = (result?.elements ?? []).map((description, index) => {
        const ref = opaque("wer");
        record.elements.set(ref, index);
        return { ref, description };
      });
      return {
        ...(await this.state(id, record)),
        elements,
        snapshot: result?.text ?? "",
        truncated: (result?.text.length ?? 0) >= maxChars,
      };
    });
  }

  async pointerSession(
    binding: CantripMcpBinding,
    input: BrowserPointerGesture,
  ): Promise<WebSessionState> {
    const record = this.record(binding, input.sessionId);
    return this.exclusive(binding, record, async (signal) => {
      this.invalidate(record);
      await browserPointerGesture(
        record.cdp,
        record.chat,
        input,
        undefined,
        () => {
          this.record(binding, input.sessionId);
        },
        signal,
      );
      signal.throwIfAborted();
      return this.state(input.sessionId, record);
    });
  }

  async clickSession(
    binding: CantripMcpBinding,
    id: string,
    ref: string,
  ): Promise<WebSessionState> {
    if (!this.records.has(id))
      return this.fallback.clickSession(binding, id, ref);
    const record = this.record(binding, id);
    return this.exclusive(binding, record, async (signal) => {
      const point = await this.point(record, ref);
      this.invalidate(record);
      await browserPointerGesture(
        record.cdp,
        record.chat,
        {
          sessionId: id,
          action: "click",
          ...point,
        },
        undefined,
        () => {
          this.record(binding, id);
        },
        signal,
      );
      return this.state(id, record);
    });
  }

  async typeSession(
    binding: CantripMcpBinding,
    id: string,
    ref: string,
    value: string,
    submit: boolean,
  ): Promise<WebSessionState> {
    if (!this.records.has(id))
      return this.fallback.typeSession(binding, id, ref, value, submit);
    const record = this.record(binding, id);
    return this.exclusive(binding, record, async (signal) => {
      const index = this.element(record, ref);
      const prepared = await record.cdp.evaluate<boolean>(`(() => {
        const node = globalThis[${JSON.stringify(record.key)}]?.[${index}];
        if (!node?.isConnected || node.disabled || node.readOnly) return false;
        if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node.isContentEditable)) return false;
        node.focus();
        if (node.select) node.select(); else { const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
        return true;
      })()`);
      if (!prepared)
        throw new Error(
          "Element is no longer editable; take a fresh snapshot.",
        );
      signal.throwIfAborted();
      this.invalidate(record);
      await record.cdp.agentCommand(record.chat, "Input.insertText", {
        text: value,
      });
      signal.throwIfAborted();
      if (submit) {
        try {
          await record.cdp.agentCommand(record.chat, "Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
          });
        } finally {
          await record.cdp.agentCommand(record.chat, "Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
          });
        }
      }
      return this.state(id, record);
    });
  }

  async closeSession(binding: CantripMcpBinding, id: string): Promise<void> {
    if (!this.records.has(id)) return this.fallback.closeSession(binding, id);
    const record = this.record(binding, id);
    if (record.busy) throw new Error("The browser operation is still running.");
    this.records.delete(id);
    record.unsubscribe();
    record.cdp.onAgentEnd?.(record.chat);
    await record.cdp
      .evaluate(`delete globalThis[${JSON.stringify(record.key)}]`)
      .catch(() => undefined);
  }

  private record(binding: CantripMcpBinding, id: string): Record_ {
    const record = this.records.get(id);
    if (
      !record ||
      record.owner !== binding.ownerId ||
      record.chat !== binding.chatId
    )
      throw new Error("Browser session belongs to another conversation.");
    if (this.lookup(record.surface, record.owner) !== record.cdp) {
      this.records.delete(id);
      record.unsubscribe();
      throw new Error(
        "Browser target was replaced or closed. Open a fresh web session; input was not replayed.",
      );
    }
    return record;
  }
  private async exclusive<T>(
    binding: CantripMcpBinding,
    record: Record_,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (record.busy)
      throw new Error(
        "Browser session has another agent operation in progress.",
      );
    record.busy = true;
    const controller = new AbortController();
    const operation = { binding, controller };
    this.operations.add(operation);
    const off = record.cdp.client.onClose((error) => controller.abort(error));
    try {
      const result = await action(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } finally {
      off();
      this.operations.delete(operation);
      record.busy = false;
      if (controller.signal.aborted) {
        try {
          record.cdp.onAgentEnd?.(record.chat);
        } catch {
          /* Presentation only. */
        }
      }
    }
  }
  private invalidate(record: Record_) {
    record.generation++;
    record.elements.clear();
  }
  private element(record: Record_, ref: string) {
    const index = record.elements.get(ref);
    if (index === undefined)
      throw new Error(
        "Element reference is stale; take a fresh browser snapshot.",
      );
    return index;
  }
  private async point(
    record: Record_,
    ref: string,
  ): Promise<{ x: number; y: number }> {
    const index = this.element(record, ref);
    const point = await record.cdp.evaluate<{
      x: number;
      y: number;
    } | null>(`(() => {
      const node = globalThis[${JSON.stringify(record.key)}]?.[${index}];
      if (!node?.isConnected) return null;
      node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = node.getBoundingClientRect();
      const x = Math.max(0,r.left) + (Math.min(innerWidth,r.right)-Math.max(0,r.left))/2;
      const y = Math.max(0,r.top) + (Math.min(innerHeight,r.bottom)-Math.max(0,r.top))/2;
      if (r.width <= 0 || r.height <= 0 || !node.contains(document.elementFromPoint(x,y))) return null;
      return { x,y };
    })()`);
    if (!point)
      throw new Error("Element is detached or covered; take a fresh snapshot.");
    return point;
  }
  private async navigate(record: Record_, url: string): Promise<void> {
    // Subscribe before dispatch so fast local navigation cannot miss readiness.
    let ready!: () => void;
    let fail!: (error: Error) => void;
    const loaded = new Promise<void>((resolve, reject) => {
      ready = resolve;
      fail = reject;
    });
    const off = record.cdp.on("Page.domContentEventFired", () => ready());
    const closed = record.cdp.client.onClose(fail);
    const timer = setTimeout(
      () => fail(new Error("Browser navigation did not become ready.")),
      30_000,
    );
    // Keep a rejection handler attached even if Page.navigate itself fails.
    void loaded.catch(() => undefined);
    try {
      const result = await record.cdp.command<{
        errorText?: string;
        loaderId?: string;
      }>("Page.navigate", { url });
      if (result.errorText) throw new Error(result.errorText);
      if (result.loaderId) await loaded;
    } finally {
      clearTimeout(timer);
      off();
      closed();
    }
  }

  private async state(id: string, record: Record_): Promise<WebSessionState> {
    const result = await record.cdp.evaluate<{ title: string; url: string }>(
      "({title:document.title,url:location.href})",
    );
    if (!result) throw new Error("Browser state is unavailable.");
    return {
      sessionId: id,
      generation: record.generation,
      persistent: true,
      title: result.title.slice(0, 1000),
      url: result.url,
    };
  }
}

import { randomUUID } from "node:crypto";
import type { RemoteBrowserServerMessage } from "@cantrip/protocol";
import type { AgentPointerDispatch } from "./browser-session.js";
import { browserCursorSprite } from "./cursor-assets.js";

type State = Extract<
  RemoteBrowserServerMessage,
  { type: "browser-agent-cursor" }
>;
/** One presentation cursor per CDP target; never consumes or produces input. */
export class BrowserAgentCursor {
  private identity: string | null = null;
  private state: State = {
    type: "browser-agent-cursor",
    epoch: randomUUID(),
    sequence: 0,
    position: null,
    click: false,
    dragging: false,
  };
  private disposed = false;
  private loadingEpoch: string | null = null;
  private retryAt = 0;
  constructor(
    private readonly emit: (state: State) => void,
    private readonly sprite = browserCursorSprite,
    private readonly now = () => performance.now(),
  ) {}

  pointer(event: AgentPointerDispatch, width: number, height: number): void {
    if (this.disposed || width <= 0 || height <= 0) return;
    this.prepare(event.identity);
    this.state = {
      ...this.state,
      sequence: this.state.sequence + 1,
      position: { x: event.x / width, y: event.y / height },
      click: event.click,
      dragging: event.dragging,
    };
    const { sprite: _sprite, ...motion } = this.state;
    this.publish(motion);
  }
  prepare(identity: string): void {
    if (this.disposed) return;
    if (this.identity !== identity) {
      this.identity = identity;
      this.state = {
        type: "browser-agent-cursor",
        epoch: randomUUID(),
        sequence: 0,
        position: null,
        click: false,
        dragging: false,
      };
      this.retryAt = 0;
    }
    const epoch = this.state.epoch;
    if (
      this.state.sprite ||
      this.loadingEpoch === epoch ||
      this.now() < this.retryAt
    )
      return;
    this.loadingEpoch = epoch;
    // Presentation recovery is independent of input and bounded to one attempt
    // per second, even during a high-frequency drag.
    void Promise.resolve()
      .then(() => this.sprite(identity))
      .then((sprite) => {
        if (this.disposed || this.state.epoch !== epoch) return;
        this.state = {
          ...this.state,
          sprite,
          click: false,
          sequence: this.state.sequence + 1,
        };
        this.publish(this.state);
      })
      .catch(() => {
        if (this.state.epoch === epoch) this.retryAt = this.now() + 1000;
      })
      .finally(() => {
        if (this.loadingEpoch === epoch) this.loadingEpoch = null;
      });
  }

  private publish(state: State): void {
    try {
      this.emit(state);
    } catch {
      /* Video clients cannot interrupt agent input. */
    }
  }
  snapshot(): State {
    return { ...this.state, click: false };
  }
  end(identity: string): void {
    if (identity === this.identity) this.hide();
  }
  hide(): void {
    if (this.disposed) return;
    this.state = {
      ...this.state,
      position: null,
      click: false,
      dragging: false,
      sequence: this.state.sequence + 1,
    };
    this.publish(this.state);
  }
  close(): void {
    if (this.disposed) return;
    this.hide();
    this.disposed = true;
  }
}

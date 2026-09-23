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
  constructor(
    private readonly emit: (state: State) => void,
    private readonly sprite = browserCursorSprite,
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
      const epoch = this.state.epoch;
      void this.sprite(identity)
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
        .catch(() => undefined);
    }
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
    this.hide();
    this.disposed = true;
  }
}

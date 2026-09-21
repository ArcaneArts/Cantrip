import { randomUUID } from "node:crypto";
import type {
  RemoteDesktopClientMessage,
  RemoteDesktopTarget,
} from "@cantrip/protocol";
import type {
  InteractionEvent,
  InteractionSprite,
  InteractionParticipant,
  WorkerInputParticipants,
} from "../computer-use/participants.js";
type Input = Extract<
  RemoteDesktopClientMessage,
  { type: "pointer" | "key" | "clipboard" }
>;
type Entry = {
  epoch: string;
  controller: AbortController;
  opening: Promise<InteractionParticipant>;
  participant: InteractionParticipant | null;
  sequence: number;
  nativeSequence: number;
  queue: Promise<unknown>;
  heldKeys: Map<string, Set<string>>;
};
const modifiers = (bits: number): ("Shift" | "Control" | "Alt" | "Meta")[] => [
  ...(bits & 1 ? ["Alt" as const] : []),
  ...(bits & 2 ? ["Control" as const] : []),
  ...(bits & 4 ? ["Meta" as const] : []),
  ...(bits & 8 ? ["Shift" as const] : []),
];
/** One input epoch per attachment/target. No global-input fallback. */
export class DesktopParticipantInput {
  private readonly entries = new Map<string, Entry>();
  private readonly cleanup = new Set<Promise<void>>();
  constructor(
    private readonly options: {
      workerId: string;
      surfaceId: string;
      participants: Pick<WorkerInputParticipants, "open">;
      state(
        attachmentId: string,
        epoch: string | null,
        message: string | null,
      ): void;
      assets?(participants: { id: string; sprite: InteractionSprite }[]): void;
      cursor?(id: string, x: number, y: number, click: boolean): void;
      readClipboard(): Promise<string>;
      clipboard(attachmentId: string, text: string): void;
    },
  ) {}
  private publishAssets(): void {
    try {
      this.options.assets?.(
        [...this.entries.values()].flatMap((entry) =>
          entry.participant?.initial?.sprite
            ? [{ id: entry.epoch, sprite: entry.participant.initial.sprite }]
            : [],
        ),
      );
    } catch {
      // Presentation transport failures must not revoke input or skip cleanup.
    }
  }
  cancel(id: string, epoch: string): boolean {
    if (this.entries.get(id)?.epoch !== epoch) return false;
    this.detach(id);
    return true;
  }
  private background(work: Promise<void>) {
    const safe = work.catch(() => {});
    this.cleanup.add(safe);
    void safe.finally(() => this.cleanup.delete(safe));
  }
  async attach(id: string, target: RemoteDesktopTarget): Promise<void> {
    const existing = this.entries.get(id);
    if (existing) {
      await existing.opening.catch(() => undefined);
      if (this.entries.get(id) === existing)
        this.options.state(id, existing.epoch, null);
      return;
    }
    if (target.kind !== "window" || !target.id) {
      this.options.state(
        id,
        null,
        "Select a window for independent input. Display sharing is view-only.",
      );
      return;
    }
    // Bind each lifetime with a new opaque ID so delayed cleanup cannot close a replacement.
    const epoch = randomUUID();
    const controller = new AbortController();
    const opening = this.options.participants.open(
      {
        workerId: this.options.workerId,
        surfaceId: this.options.surfaceId,
        attachmentId: epoch,
        participantId: id,
      },
      `macos-window-${target.id}`,
      controller.signal,
    );
    const entry: Entry = {
      epoch,
      controller,
      opening,
      participant: null,
      sequence: 0,
      nativeSequence: 0,
      queue: Promise.resolve(),
      heldKeys: new Map(),
    };
    this.entries.set(id, entry);
    try {
      const participant = await opening;
      if (this.entries.get(id) !== entry) {
        await participant.close();
        return;
      }
      entry.participant = participant;
      this.publishAssets();
      this.options.state(id, epoch, null);
    } catch {
      if (this.entries.get(id) === entry) {
        this.entries.delete(id);
        this.options.state(
          id,
          null,
          "Window input could not attach. Reconnect to try again; no system input was used.",
        );
      }
    }
  }
  detach(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.publishAssets();
    entry.controller.abort();
    this.options.state(id, null, null);
    this.background(entry.opening.then((p) => p.close()));
  }
  reset(): void {
    for (const id of this.entries.keys()) this.detach(id);
  }
  async close(): Promise<void> {
    this.reset();
    await Promise.all(this.cleanup);
  }
  async send(
    id: string,
    message: Input,
    dimensions: {
      pixelWidth: number;
      pixelHeight: number;
      logicalWidth: number;
      logicalHeight: number;
    },
  ): Promise<void> {
    const entry = this.entries.get(id);
    if (
      !entry ||
      !entry.participant ||
      message.inputEpoch !== entry.epoch ||
      !message.inputSequence ||
      message.inputSequence <= entry.sequence
    )
      throw new Error(
        "Remote input is stale or unavailable; no input was sent.",
      );
    entry.sequence = message.inputSequence;
    const submitted = structuredClone(message);
    const work = entry.queue.then(async () => {
      if (this.entries.get(id) !== entry)
        throw new Error("Remote input target changed; no input was sent.");
      const post = async (event: InteractionEvent) => {
        if (this.entries.get(id) !== entry)
          throw new Error("Remote input was detached.");
        await entry.participant!.send(
          ++entry.nativeSequence,
          event,
          entry.controller.signal,
        );
      };
      if (submitted.type === "pointer") {
        const point = {
          x: (submitted.x * dimensions.logicalWidth) / dimensions.pixelWidth,
          y: (submitted.y * dimensions.logicalHeight) / dimensions.pixelHeight,
        };
        const mods = modifiers(submitted.modifiers);
        if (submitted.event === "move")
          await post({ type: "pointerMove", data: { point, modifiers: mods } });
        else if (submitted.event === "wheel")
          await post({
            type: "scroll",
            data: {
              point,
              deltaX: Math.round(submitted.deltaX),
              deltaY: Math.round(submitted.deltaY),
              modifiers: mods,
            },
          });
        else if (submitted.button !== "none")
          await post(
            submitted.event === "down"
              ? {
                  type: "pointerDown",
                  data: { point, button: submitted.button, modifiers: mods },
                }
              : {
                  type: "pointerUp",
                  data: { point, button: submitted.button },
                },
          );
        try {
          this.options.cursor?.(
            entry.epoch,
            Math.min(1, submitted.x / dimensions.pixelWidth),
            Math.min(1, submitted.y / dimensions.pixelHeight),
            submitted.event === "down",
          );
        } catch {
          // A lost cursor update is not a failed native input operation.
        }
      } else if (submitted.type === "key") {
        const key =
          submitted.code.match(/^Key([A-Z])$/)?.[1] ??
          submitted.code.match(/^Digit([0-9])$/)?.[1] ??
          (
            {
              Space: "Space",
              MetaLeft: "Meta",
              MetaRight: "Meta",
              ControlLeft: "Control",
              ControlRight: "Control",
              AltLeft: "Alt",
              AltRight: "Alt",
              ShiftLeft: "Shift",
              ShiftRight: "Shift",
            } as Record<string, string>
          )[submitted.code] ??
          submitted.key;
        const physical = submitted.code || submitted.key;
        const held = entry.heldKeys.get(key) ?? new Set<string>();
        if (submitted.event === "down") {
          // Left/right modifiers share one native key, but own separate holds.
          if (!held.size || held.has(physical))
            await post({
              type: "keyDown",
              data: {
                key,
                modifiers: modifiers(submitted.modifiers),
                repeat: held.has(physical),
              },
            });
          held.add(physical);
          entry.heldKeys.set(key, held);
        } else if (held.delete(physical) && !held.size) {
          entry.heldKeys.delete(key);
          await post({ type: "keyUp", data: { key } });
        }
      } else if (submitted.operation === "paste-text") {
        // Split UTF-8 text without splitting code points. The attachment sequence
        // is consumed once; generated native events are never retried.
        let chunk = "";
        let bytes = 0;
        for (const character of submitted.text) {
          const size = Buffer.byteLength(character);
          if (bytes + size > 8192) {
            await post({ type: "text", data: { type: "commit", data: chunk } });
            chunk = "";
            bytes = 0;
          }
          chunk += character;
          bytes += size;
        }
        if (chunk)
          await post({ type: "text", data: { type: "commit", data: chunk } });
      } else {
        await post({
          type: "keyDown",
          data: { key: "C", modifiers: ["Meta"], repeat: false },
        });
        await post({ type: "keyUp", data: { key: "C" } });
        await new Promise((resolve) => setTimeout(resolve, 60));
        const text = await this.options.readClipboard();
        if (this.entries.get(id) === entry) this.options.clipboard(id, text);
      }
    });
    entry.queue = work;
    try {
      await work;
    } catch (error) {
      if (this.entries.get(id) === entry) {
        this.detach(id);
        this.options.state(
          id,
          null,
          "Input stopped; delivery may be uncertain. Reconnect without replaying the last action.",
        );
      }
      throw error;
    }
  }
}

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  CuaSession,
  CuaAgentObservation,
  CuaAgentSources,
} from "@cantrip/protocol/computer-use";
import type { CuaPreviewAuthority } from "@cantrip/protocol/computer-use-preview";
import { CuaAuthorizationError } from "./handler.js";
import { CuaNativeError } from "./errors.js";
import {
  CUA_MODEL_MAX_IMAGE_BYTES,
  decodeCuaModelImageBase64,
} from "./model-image-contract.js";
import type { CuaModelImage } from "./model-images.js";

interface Observation {
  token: symbol;
  authority: CuaPreviewAuthority;
  metadata: CuaAgentObservation;
  data: string;
  signal: AbortSignal;
  current(): CuaSession | null;
  dispose(): void;
}

/** References at most four already-produced immutable model strings. No native
 * capture, encoding, persistent storage, or independently retained byte buffer.
 * Epochs fence late completions even when an entry was cleared or evicted. */
export class CuaAgentObservations {
  private readonly epochs = new WeakMap<object, symbol>();
  private readonly entries = new Map<object, Observation>();
  private readers = 0;

  begin(lifetime: object): symbol {
    this.clear(lifetime);
    const token = Symbol();
    this.epochs.set(lifetime, token);
    return token;
  }

  clear(lifetime: object, token?: symbol): void {
    if (token && this.epochs.get(lifetime) !== token) return;
    this.epochs.delete(lifetime);
    const entry = this.entries.get(lifetime);
    this.entries.delete(lifetime);
    entry?.dispose();
  }

  publish(
    lifetime: object,
    token: symbol,
    input: {
      authority: CuaPreviewAuthority;
      rootThreadId: string;
      image: CuaModelImage;
      signal: AbortSignal;
      current(): CuaSession | null;
    },
  ): void {
    if (this.epochs.get(lifetime) !== token || input.signal.aborted) return;
    const { image } = input;
    const { session } = image.native;
    if (
      !session.target ||
      !session.binding.threadId ||
      !session.binding.turnId ||
      image.model.byteCount <= 0 ||
      image.model.byteCount > CUA_MODEL_MAX_IMAGE_BYTES ||
      image.content.data.length !== 4 * Math.ceil(image.model.byteCount / 3)
    )
      return;
    const metadata: CuaAgentObservation = structuredClone({
      source: {
        sourceId: randomUUID(),
        rootThreadId: input.rootThreadId,
        binding: {
          ...session.binding,
          threadId: session.binding.threadId,
          turnId: session.binding.turnId,
        },
        target: session.target,
        cursorRevision: session.cursor.revision,
        observationRevision: session.observationRevision,
        observedAtMs: Date.now(),
      },
      session,
      image: { mediaType: "image/png", cursorIncluded: true, ...image.model },
      nativeImage: image.native.image,
    });
    const abort = () => this.clear(lifetime, token);
    const retention = new AbortController();
    const entry: Observation = {
      token,
      authority: structuredClone(input.authority),
      metadata,
      data: image.content.data,
      signal: retention.signal,
      current: input.current,
      dispose: () => {
        retention.abort();
        input.signal.removeEventListener("abort", abort);
      },
    };
    if (!this.valid(entry)) return;
    while (this.entries.size >= 4)
      this.clear(this.entries.keys().next().value!);
    this.entries.set(lifetime, entry);
    input.signal.addEventListener("abort", abort, { once: true });
  }

  private valid(entry: Observation): boolean {
    if (entry.signal.aborted) return false;
    try {
      const current = entry.current();
      const captured = entry.metadata.session;
      return (
        !!current &&
        isDeepStrictEqual(current.binding, captured.binding) &&
        current.target?.id === captured.target?.id &&
        current.target?.generation === captured.target?.generation &&
        current.cursor.revision === captured.cursor.revision &&
        current.observationRevision === captured.observationRevision
      );
    } catch {
      return false;
    }
  }

  private matching(authority: CuaPreviewAuthority): Observation[] {
    const found: Observation[] = [];
    for (const [lifetime, entry] of this.entries) {
      if (!this.valid(entry)) {
        this.clear(lifetime, entry.token);
        continue;
      }
      // The agent's execution lane is not part of preview authority. All
      // durable owner/placement/profile/generation claims must still match.
      const keys: Array<keyof CuaPreviewAuthority> = [
        "ownerId",
        "serverId",
        "workerId",
        "chatId",
        "projectId",
        "contextKind",
        "placementId",
        "generation",
        "profile",
      ];
      if (
        keys.every((key) =>
          isDeepStrictEqual(authority[key], entry.authority[key]),
        )
      )
        found.push(entry);
    }
    return found;
  }

  list(authority: CuaPreviewAuthority): CuaAgentSources {
    return {
      sources: this.matching(authority).map((entry) =>
        structuredClone(entry.metadata.source),
      ),
    };
  }

  read(
    authority: CuaPreviewAuthority,
    sourceId: string,
  ): CuaAgentObservation & {
    payload: Buffer;
    signal: AbortSignal;
    release(): void;
  } {
    const entry = this.matching(authority).find(
      (entry) => entry.metadata.source.sourceId === sourceId,
    );
    if (!entry) throw new CuaAuthorizationError("execution-unavailable");
    // Hold reservations through actual caller cleanup, including encryption
    // still settling after source cancellation. Abort alone frees no bytes.
    if (this.readers >= 4) throw new CuaNativeError("capacity");
    this.readers++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.readers--;
    };
    try {
      return {
        ...structuredClone(entry.metadata),
        payload: decodeCuaModelImageBase64(entry.data),
        signal: entry.signal,
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  }
}

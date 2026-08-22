import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";

import {
  remoteSurfaceKeyInput,
  remoteSurfacePointerInput,
  remoteSurfaceTouchInput,
  remoteSurfaceWheelInput,
  type RemoteSurfaceBounds,
  type RemoteSurfaceCoordinateLimit,
  type RemoteSurfaceKeyInput,
  type RemoteSurfaceModifierState,
  type RemoteSurfacePointerInput,
  type RemoteSurfaceSize,
  type RemoteSurfaceTouchInput,
} from "@/lib/remote-surface-input";

export type RemoteSurfaceFramePolicy = "latest" | "ordered";

export interface RemoteSurfaceFrameFeedback {
  averageDecodeMs: number;
  droppedFrames: number;
  intervalMs: number;
  receivedFrames: number;
  renderedFrames: number;
}

interface RemoteSurfaceBitmap {
  close(): void;
  height: number;
  width: number;
}

interface RemoteSurfaceFrameRendererOptions {
  decodeFrame?(bytes: Uint8Array): Promise<RemoteSurfaceBitmap>;
  drawFrame?(canvas: HTMLCanvasElement, bitmap: RemoteSurfaceBitmap): void;
  getCanvas(): HTMLCanvasElement | null;
  now?(): number;
  onError(): void;
  onRendered(): void;
  policy: RemoteSurfaceFramePolicy;
}

interface RemoteSurfaceFrameStats {
  decodeTimeMs: number;
  droppedFrames: number;
  receivedFrames: number;
  renderedFrames: number;
  startedAt: number;
}

export class RemoteSurfaceFrameRenderer {
  readonly #options: RemoteSurfaceFrameRendererOptions;
  #decodingGeneration: number | null = null;
  #disposed = false;
  #generation = 0;
  #pending: Uint8Array[] = [];
  #stats: RemoteSurfaceFrameStats;

  constructor(options: RemoteSurfaceFrameRendererOptions) {
    this.#options = options;
    this.#stats = this.newStats();
  }

  push(frame: Uint8Array): void {
    if (this.#disposed) return;
    this.#stats.receivedFrames += 1;
    const copy = new Uint8Array(frame);
    if (this.#options.policy === "latest" && this.#pending.length > 0) {
      this.#pending[0] = copy;
      this.#stats.droppedFrames += 1;
    } else {
      this.#pending.push(copy);
    }
    void this.pump();
  }

  reset(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#pending = [];
    this.#stats = this.newStats();
  }

  takeFeedback(): RemoteSurfaceFrameFeedback {
    const now = this.now();
    const stats = this.#stats;
    const feedback = {
      intervalMs: Math.max(250, Math.round(now - stats.startedAt)),
      receivedFrames: stats.receivedFrames,
      renderedFrames: stats.renderedFrames,
      droppedFrames: stats.droppedFrames,
      averageDecodeMs: stats.renderedFrames
        ? stats.decodeTimeMs / stats.renderedFrames
        : 0,
    };
    this.#stats = this.newStats(now);
    return feedback;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#pending = [];
  }

  private async pump(): Promise<void> {
    const generation = this.#generation;
    if (
      this.#disposed ||
      this.#pending.length === 0 ||
      this.#decodingGeneration === generation
    ) {
      return;
    }
    const frame = this.#pending.shift();
    if (!frame) return;
    this.#decodingGeneration = generation;
    const startedAt = this.now();
    let bitmap: RemoteSurfaceBitmap | null = null;
    try {
      bitmap = await this.decodeFrame(frame);
      if (this.#disposed || this.#generation !== generation) {
        bitmap.close();
        bitmap = null;
        return;
      }
      const canvas = this.#options.getCanvas();
      if (!canvas) {
        bitmap.close();
        bitmap = null;
        return;
      }
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      this.drawFrame(canvas, bitmap);
      bitmap.close();
      bitmap = null;
      this.#stats.renderedFrames += 1;
      this.#stats.decodeTimeMs += this.now() - startedAt;
      this.#options.onRendered();
    } catch {
      bitmap?.close();
      if (!this.#disposed && this.#generation === generation) {
        this.#options.onError();
      }
    } finally {
      if (this.#decodingGeneration === generation) {
        this.#decodingGeneration = null;
      }
      if (!this.#disposed && this.#pending.length > 0) void this.pump();
    }
  }

  private decodeFrame(bytes: Uint8Array): Promise<RemoteSurfaceBitmap> {
    if (this.#options.decodeFrame) return this.#options.decodeFrame(bytes);
    return createImageBitmap(
      new Blob([Uint8Array.from(bytes).buffer], { type: "image/jpeg" }),
    );
  }

  private drawFrame(
    canvas: HTMLCanvasElement,
    bitmap: RemoteSurfaceBitmap,
  ): void {
    if (this.#options.drawFrame) {
      this.#options.drawFrame(canvas, bitmap);
      return;
    }
    canvas.getContext("2d")?.drawImage(bitmap as CanvasImageSource, 0, 0);
  }

  private now(): number {
    return this.#options.now?.() ?? performance.now();
  }

  private newStats(startedAt = this.now()): RemoteSurfaceFrameStats {
    return {
      decodeTimeMs: 0,
      droppedFrames: 0,
      receivedFrames: 0,
      renderedFrames: 0,
      startedAt,
    };
  }
}

export interface RemoteSurfaceCanvasHandle {
  pushFrame(frame: Uint8Array): void;
  reset(): void;
  takeFrameFeedback(): RemoteSurfaceFrameFeedback;
}

export interface RemoteSurfaceCanvasProps {
  allowAltModifiedText: boolean;
  ariaLabel: string;
  className?: string;
  coordinateLimit: RemoteSurfaceCoordinateLimit;
  cursor?: string;
  framePolicy: RemoteSurfaceFramePolicy;
  getCoordinateSpace(): RemoteSurfaceSize;
  ignoreRepeatedKeyDown?: boolean;
  onFocus(): void;
  onFrameError(): void;
  onKey(input: RemoteSurfaceKeyInput): void;
  onPointer(input: RemoteSurfacePointerInput): void;
  onRendered(): void;
  onTouch?(input: RemoteSurfaceTouchInput): void;
  pointerMoveThrottleMs?: number;
  preventContextMenu?: boolean;
  style?: CSSProperties;
}

export interface RemoteSurfaceTouchPointerEvent extends RemoteSurfaceModifierState {
  clientX: number;
  clientY: number;
  height: number;
  pointerId: number;
  pressure: number;
  width: number;
}

type RemoteSurfaceTouchPointerPhase = "cancel" | "down" | "move" | "up";

export class RemoteSurfaceTouchPointerTracker {
  readonly #active = new Map<
    number,
    {
      clientX: number;
      clientY: number;
      force: number;
      identifier: number;
      radiusX: number;
      radiusY: number;
    }
  >();

  input(
    event: RemoteSurfaceTouchPointerEvent,
    phase: RemoteSurfaceTouchPointerPhase,
    bounds: RemoteSurfaceBounds,
    target: RemoteSurfaceSize,
  ): RemoteSurfaceTouchInput | null {
    if (phase === "move" && !this.#active.has(event.pointerId)) return null;
    if (phase === "up" && !this.#active.has(event.pointerId)) return null;
    if (phase === "cancel") {
      this.#active.clear();
    } else if (phase === "up") {
      this.#active.delete(event.pointerId);
    } else {
      this.#active.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
        force: event.pressure,
        identifier: event.pointerId,
        radiusX: event.width / 2,
        radiusY: event.height / 2,
      });
    }
    const eventType =
      phase === "down"
        ? "start"
        : phase === "up" && this.#active.size > 0
          ? "move"
          : phase === "up"
            ? "end"
            : phase;
    return remoteSurfaceTouchInput(
      { ...event, touches: [...this.#active.values()] },
      eventType,
      bounds,
      target,
    );
  }

  reset(): void {
    this.#active.clear();
  }
}

export const RemoteSurfaceCanvas = forwardRef<
  RemoteSurfaceCanvasHandle,
  RemoteSurfaceCanvasProps
>(function RemoteSurfaceCanvas(
  {
    allowAltModifiedText,
    ariaLabel,
    className,
    coordinateLimit,
    cursor,
    framePolicy,
    getCoordinateSpace,
    ignoreRepeatedKeyDown = false,
    onFocus,
    onFrameError,
    onKey,
    onPointer,
    onRendered,
    onTouch,
    pointerMoveThrottleMs = 0,
    preventContextMenu = false,
    style,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<RemoteSurfaceFrameRenderer | null>(null);
  const callbacksRef = useRef({ onFrameError, onRendered });
  const lastPointerMoveAtRef = useRef(0);
  const touchPointersRef = useRef(new RemoteSurfaceTouchPointerTracker());
  callbacksRef.current = { onFrameError, onRendered };

  useEffect(() => {
    const renderer = new RemoteSurfaceFrameRenderer({
      policy: framePolicy,
      getCanvas: () => canvasRef.current,
      onError: () => callbacksRef.current.onFrameError(),
      onRendered: () => callbacksRef.current.onRendered(),
    });
    rendererRef.current = renderer;
    return () => {
      if (rendererRef.current === renderer) rendererRef.current = null;
      renderer.dispose();
    };
  }, [framePolicy]);

  useImperativeHandle(
    ref,
    () => ({
      pushFrame: (frame) => rendererRef.current?.push(frame),
      reset: () => {
        rendererRef.current?.reset();
        touchPointersRef.current.reset();
      },
      takeFrameFeedback: () =>
        rendererRef.current?.takeFeedback() ?? {
          averageDecodeMs: 0,
          droppedFrames: 0,
          intervalMs: 250,
          receivedFrames: 0,
          renderedFrames: 0,
        },
    }),
    [],
  );

  const pointer = (
    event: PointerEvent<HTMLCanvasElement>,
    type: RemoteSurfaceTouchPointerPhase,
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (event.pointerType === "touch" && onTouch) {
      // WKWebView can stop delivering the parallel legacy touch stream once
      // pointer handling owns the gesture, so capture and forward this stream.
      event.preventDefault();
      if (type === "down") {
        canvas.focus();
        canvas.setPointerCapture(event.pointerId);
      }
      const input = touchPointersRef.current.input(
        event,
        type,
        canvas.getBoundingClientRect(),
        getCoordinateSpace(),
      );
      if (input) onTouch(input);
      return;
    }
    if (
      type === "move" &&
      pointerMoveThrottleMs > 0 &&
      performance.now() - lastPointerMoveAtRef.current < pointerMoveThrottleMs
    ) {
      return;
    }
    if (type === "move") lastPointerMoveAtRef.current = performance.now();
    if (type === "down") {
      canvas.focus();
      canvas.setPointerCapture(event.pointerId);
    }
    onPointer(
      remoteSurfacePointerInput(
        event,
        type === "cancel" ? "up" : type,
        canvas.getBoundingClientRect(),
        getCoordinateSpace(),
        coordinateLimit,
      ),
    );
  };

  const wheel = (event: WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    onPointer(
      remoteSurfaceWheelInput(
        event,
        canvas.getBoundingClientRect(),
        getCoordinateSpace(),
        coordinateLimit,
      ),
    );
  };

  const key = (
    event: KeyboardEvent<HTMLCanvasElement>,
    type: "down" | "up",
  ) => {
    event.preventDefault();
    if (type === "down" && ignoreRepeatedKeyDown && event.repeat) return;
    onKey(
      remoteSurfaceKeyInput(event, type, {
        allowAltModifiedText,
      }),
    );
  };

  return (
    <canvas
      ref={canvasRef}
      aria-label={ariaLabel}
      className={className}
      style={{ ...style, cursor }}
      tabIndex={0}
      onFocus={onFocus}
      onContextMenu={
        preventContextMenu ? (event) => event.preventDefault() : undefined
      }
      onPointerDown={(event) => pointer(event, "down")}
      onPointerMove={(event) => pointer(event, "move")}
      onPointerUp={(event) => pointer(event, "up")}
      onPointerCancel={(event) => pointer(event, "cancel")}
      onWheel={wheel}
      onKeyDown={(event) => key(event, "down")}
      onKeyUp={(event) => key(event, "up")}
    />
  );
});

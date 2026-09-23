import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { RemoteBrowserServerMessage } from "@cantrip/protocol";
import {
  RemoteCursorOverlay,
  type CursorAsset,
  type CursorOverlayHandle,
} from "../remote-surface/cursor-overlay";
type State = Extract<
  RemoteBrowserServerMessage,
  { type: "browser-agent-cursor" }
>;
export interface BrowserAgentCursorHandle {
  receive(state: State): void;
  reset(): void;
}

/** Presentation only; this layer is never inserted into the captured webpage. */
export const BrowserAgentCursorOverlay = forwardRef<BrowserAgentCursorHandle>(
  function BrowserAgentCursorOverlay(_, ref) {
    const host = useRef<HTMLDivElement>(null);
    const overlay = useRef<CursorOverlayHandle>(null);
    const latest = useRef<State | null>(null);
    const [assets, setAssets] = useState<CursorAsset[]>([]);
    const [visible, setVisible] = useState(false);
    const [size, setSize] = useState({ width: 0, height: 0 });
    useEffect(() => {
      if (!host.current) return;
      const observer = new ResizeObserver(([entry]) => {
        if (entry)
          setSize({
            width: entry.contentRect.width,
            height: entry.contentRect.height,
          });
      });
      observer.observe(host.current);
      return () => observer.disconnect();
    }, []);
    useImperativeHandle(
      ref,
      () => ({
        reset() {
          latest.current = null;
          setAssets([]);
          setVisible(false);
        },
        receive(state) {
          const previous = latest.current;
          if (
            previous?.epoch === state.epoch &&
            previous.sequence >= state.sequence
          )
            return;
          latest.current = state;
          if (previous?.epoch !== state.epoch) setAssets([]);
          if (state.sprite)
            setAssets([{ id: state.epoch, sprite: state.sprite }]);
          setVisible(state.position !== null);
          if (state.position)
            overlay.current?.remote(
              state.epoch,
              state.position.x,
              state.position.y,
              state.click,
              !state.dragging,
            );
        },
      }),
      [],
    );
    useEffect(() => {
      const state = latest.current;
      if (state?.position)
        overlay.current?.remote(
          state.epoch,
          state.position.x,
          state.position.y,
          false,
        );
    }, [assets, visible]);
    return (
      <div
        ref={host}
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ opacity: visible ? 1 : 0 }}
      >
        <RemoteCursorOverlay
          ref={overlay}
          assets={assets}
          ownId={null}
          width={size.width}
          height={size.height}
        />
      </div>
    );
  },
);

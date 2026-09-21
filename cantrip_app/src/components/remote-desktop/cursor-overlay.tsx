import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { RemoteDesktopServerMessage } from "@cantrip/protocol";
type Assets = Extract<
  RemoteDesktopServerMessage,
  { type: "desktop-cursor-assets" }
>["participants"];
export interface CursorOverlayHandle {
  move(x: number, y: number, click: boolean): void;
  remote(id: string, x: number, y: number, click: boolean): void;
}
/** Sprites are drawn by the shared native rasterizer. No video pixels are used. */
export const RemoteCursorOverlay = forwardRef<
  CursorOverlayHandle,
  { assets: Assets; ownId: string | null; width: number; height: number }
>(function RemoteCursorOverlay({ assets, ownId, width, height }, ref) {
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const [urls, setUrls] = useState(
    new Map<string, { normal: string; click: string }>(),
  );
  const position = useRef<{ x: number; y: number; click: boolean } | null>(
    null,
  );
  const peerPositions = useRef(new Map<string, { x: number; y: number }>());
  const place = (id: string, x: number, y: number, click: boolean) => {
    const node = nodes.current.get(id);
    if (!node) return;
    node.style.left = `${x * 100}%`;
    node.style.top = `${y * 100}%`;
    node.style.visibility = "visible";
    if (click)
      node
        .querySelector<HTMLElement>("[data-glow]")
        ?.animate?.([{ opacity: 1 }, { opacity: 0 }], {
          duration: 240,
          easing: "ease-out",
        });
  };
  useImperativeHandle(
    ref,
    () => ({
      move(x, y, click) {
        position.current = { x, y, click };
        if (ownId) place(ownId, x, y, click);
      },
      remote(id, x, y, click) {
        if (id !== ownId) {
          peerPositions.current.set(id, { x, y });
          place(id, x, y, click);
        }
      },
    }),
    [ownId],
  );
  useEffect(() => {
    const next = new Map<string, { normal: string; click: string }>();
    for (const { id, sprite } of assets)
      next.set(id, {
        normal: URL.createObjectURL(
          new Blob([new Uint8Array(sprite.normal)], { type: "image/png" }),
        ),
        click: URL.createObjectURL(
          new Blob([new Uint8Array(sprite.click)], { type: "image/png" }),
        ),
      });
    setUrls(next);
    return () => {
      for (const value of next.values()) {
        URL.revokeObjectURL(value.normal);
        URL.revokeObjectURL(value.click);
      }
    };
  }, [assets]);
  useEffect(() => {
    for (const [id, point] of peerPositions.current) {
      if (!assets.some((asset) => asset.id === id))
        peerPositions.current.delete(id);
      else if (id !== ownId) place(id, point.x, point.y, false);
    }
    if (ownId && position.current) {
      const { x, y } = position.current;
      place(ownId, x, y, false);
    }
  }, [assets, ownId, urls]);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-1/2 overflow-hidden"
      style={{ width, height, transform: "translate(-50%,-50%)" }}
    >
      {assets.map(({ id, sprite }) => {
        const images = urls.get(id);
        return (
          <div
            key={id}
            ref={(node) => {
              if (node) nodes.current.set(id, node);
              else nodes.current.delete(id);
            }}
            className="absolute"
            style={{
              visibility: "hidden",
              width: sprite.width,
              height: sprite.height,
              transform: `translate(-${sprite.hotspot.x}px,-${sprite.hotspot.y}px)`,
            }}
          >
            {images ? (
              <>
                <img
                  alt=""
                  draggable={false}
                  src={images.normal}
                  className="absolute inset-0 h-full w-full"
                />
                <img
                  alt=""
                  draggable={false}
                  src={images.click}
                  data-glow
                  className="absolute inset-0 h-full w-full opacity-0"
                />
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
});

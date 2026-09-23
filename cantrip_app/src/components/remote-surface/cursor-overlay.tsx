import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { remoteCursorSpriteSchema } from "@cantrip/protocol";
/** Cursor assets are independent of the surface's video or input backend. */
export interface CursorAsset {
  id: string;
  sprite: ReturnType<typeof remoteCursorSpriteSchema.parse>;
}
type Assets = readonly CursorAsset[];
export interface CursorOverlayHandle {
  move(x: number, y: number, click: boolean): void;
  remote(
    id: string,
    x: number,
    y: number,
    click: boolean,
    smooth?: boolean,
  ): void;
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
  const place = (
    id: string,
    x: number,
    y: number,
    click: boolean,
    smooth = false,
  ) => {
    const node = nodes.current.get(id);
    if (!node) return;
    const policy = assets.find((asset) => asset.id === id)?.sprite.motion;
    const previous = peerPositions.current.get(id);
    const distance = previous
      ? Math.hypot((x - previous.x) * width, (y - previous.y) * height)
      : 0;
    const duration =
      policy && distance >= policy.minimumDistance
        ? Math.min(
            policy.maxDurationMs,
            Math.max(policy.minDurationMs, distance / policy.pixelsPerMs),
          )
        : 0;
    node.style.transition =
      smooth && !click && policy && duration > 0
        ? `left ${duration}ms cubic-bezier(${policy.easing.join(",")}), top ${duration}ms cubic-bezier(${policy.easing.join(",")})`
        : "none";
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
      remote(id, x, y, click, smooth) {
        if (id !== ownId) {
          place(id, x, y, click, smooth);
          peerPositions.current.set(id, { x, y });
        }
      },
    }),
    [ownId, assets, width, height],
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

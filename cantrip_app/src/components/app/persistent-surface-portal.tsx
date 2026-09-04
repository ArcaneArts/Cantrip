import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Keeps a live surface mounted in one stable portal container while its pane
 * host moves through the recursive layout. A temporarily absent host parks
 * the owner in its last pane (which may itself be detached) without remounting.
 */
export function PersistentSurfacePortal({
  children,
  host,
  portalKey,
}: {
  children: ReactNode;
  host: Element | null;
  portalKey: string;
}) {
  const [target] = useState(() => {
    if (typeof document === "undefined") return null;
    const element = document.createElement("div");
    element.className = "contents";
    element.dataset.persistentSurfaceOwner = portalKey;
    return element;
  });
  useLayoutEffect(() => {
    if (host && target && target.parentElement !== host) {
      host.appendChild(target);
    }
  }, [host, target]);
  useLayoutEffect(
    () => () => {
      target?.remove();
    },
    [target],
  );
  return target ? createPortal(children, target, portalKey) : children;
}

import { useLayoutEffect, useRef } from "react";
import { hasScrolledContent } from "./scroll-divider";

/** A panel owns its scroll chrome. Crossing the top boundary changes one CSS
 * property; ordinary scroll frames never schedule React or workspace renders. */
export function usePanelScrollDivider(scope: string, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const scrolled = new Set<Element>();
    const owned = (element: Element) =>
      element.closest("[data-panel-scroll-root]") === root;
    const paint = () => {
      for (const element of scrolled)
        if (
          !root.contains(element) ||
          !owned(element) ||
          !hasScrolledContent(element)
        )
          scrolled.delete(element);
      const opacity = enabled && scrolled.size > 0 ? "1" : "0";
      if (
        root.style.getPropertyValue("--panel-scroll-divider-opacity") !==
        opacity
      )
        root.style.setProperty("--panel-scroll-divider-opacity", opacity);
    };
    // Includes an already restored native textarea and non-native file previews.
    // This scan happens on document/mode activation, never on keystrokes or frames.
    if (enabled)
      for (const element of root.querySelectorAll("*"))
        if (owned(element) && hasScrolledContent(element))
          scrolled.add(element);
    paint();
    if (!enabled) return;
    const update = (event: Event) => {
      const element = event.target;
      if (!(element instanceof Element) || !owned(element)) return;
      if (hasScrolledContent(element)) scrolled.add(element);
      else scrolled.delete(element);
      paint();
    };
    root.addEventListener("scroll", update, true);
    return () => root.removeEventListener("scroll", update, true);
  }, [scope, enabled]);
  return ref;
}

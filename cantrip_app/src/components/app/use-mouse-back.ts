import { useEffect, useRef } from "react";

/** Consume a Back-button gesture without also navigating the webview history. */
export function listenForMouseBack(
  target: EventTarget,
  getBack: () => (() => void) | null,
) {
  let claimed = false;
  let completed = false;
  const handle = (raw: Event) => {
    const event = raw as MouseEvent;
    if (event.button !== 3) return;
    if (event.type === "mousedown") {
      claimed = getBack() !== null;
      completed = false;
    }
    if (!claimed && !getBack()) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type !== "mousedown" && !completed) {
      completed = true;
      getBack()?.();
    }
    if (event.type === "auxclick") claimed = false;
  };
  const events = ["mousedown", "mouseup", "auxclick"];
  for (const event of events)
    target.addEventListener(event, handle, { capture: true });
  return () => {
    for (const event of events)
      target.removeEventListener(event, handle, { capture: true });
  };
}

export function useMouseBack(onBack: (() => void) | null) {
  const back = useRef(onBack);
  back.current = onBack;
  useEffect(() => listenForMouseBack(window, () => back.current), []);
}

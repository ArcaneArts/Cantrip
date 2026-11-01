type FindShortcut = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;
export function isFindShortcut(event: FindShortcut): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "f"
  );
}
interface Entry {
  root: HTMLElement;
  open(): void;
}
interface Scope {
  entries: Map<HTMLElement, Entry>;
  recent: HTMLElement | null;
  key(event: KeyboardEvent): void;
}
const scopes = new WeakMap<Document, Scope>();

/** Route the window shortcut to a visible editor, without stealing other inputs
 * or another workspace pane's keyboard commands. No listener survives its view. */
export function registerFindEditor(
  root: HTMLElement,
  open: () => void,
): () => void {
  const document = root.ownerDocument;
  let scope = scopes.get(document);
  if (!scope) {
    const entries = new Map<HTMLElement, Entry>();
    scope = {
      entries,
      recent: null,
      key(event) {
        if (
          event.defaultPrevented ||
          event.isComposing ||
          !isFindShortcut(event)
        )
          return;
        const target = event.target instanceof Element ? event.target : null;
        const visible = [...entries.values()].filter(
          ({ root }) =>
            root.getClientRects().length > 0 &&
            !root.closest('[inert],[aria-hidden="true"]') &&
            document.defaultView?.getComputedStyle(root).visibility !==
              "hidden",
        );
        const inside = visible.find(
          (entry) => target && entry.root.contains(target),
        );
        if (
          !inside &&
          target?.closest(
            'input,textarea,[contenteditable="true"],[role="textbox"]',
          )
        )
          return;
        const pane = target
          ?.closest("[data-project-pane-id]")
          ?.getAttribute("data-project-pane-id");
        const fromFiles = target?.closest(
          '[role="tree"][aria-label="Project files"]',
        );
        const candidates =
          pane && !fromFiles
            ? visible.filter(
                (entry) =>
                  entry.root
                    .closest("[data-project-pane-id]")
                    ?.getAttribute("data-project-pane-id") === pane,
              )
            : visible;
        const entry =
          inside ??
          candidates.find((entry) => entry.root === scope!.recent) ??
          candidates.at(-1);
        if (!entry) return;
        event.preventDefault();
        event.stopPropagation();
        entry.open();
      },
    };
    scopes.set(document, scope);
    document.addEventListener("keydown", scope.key);
  }
  scope.entries.set(root, { root, open });
  scope.recent = root;
  const focus = () => {
    scope!.recent = root;
  };
  root.addEventListener("focusin", focus);
  root.addEventListener("pointerdown", focus);
  return () => {
    root.removeEventListener("focusin", focus);
    root.removeEventListener("pointerdown", focus);
    scope!.entries.delete(root);
    if (scope!.entries.size === 0) {
      document.removeEventListener("keydown", scope!.key);
      scopes.delete(document);
    }
  };
}

export const NATIVE_TOOLTIP_OBSERVER_OPTIONS: MutationObserverInit = {
  attributeFilter: ["title"],
  attributes: true,
  characterData: true,
  childList: true,
  subtree: true,
};

function suppressNativeTooltipElement(element: Element): boolean {
  let changed = false;
  if (element.hasAttribute("title")) {
    element.removeAttribute("title");
    changed = true;
  }
  if (element.matches("svg title") && element.textContent) {
    element.textContent = "";
    changed = true;
  }
  return changed;
}

export function suppressNativeTooltips(root: ParentNode): number {
  let suppressed = 0;
  if (root.nodeType === 1 && suppressNativeTooltipElement(root as Element)) {
    suppressed += 1;
  }
  for (const element of root.querySelectorAll("[title], svg title")) {
    if (suppressNativeTooltipElement(element)) suppressed += 1;
  }
  return suppressed;
}

export function installNativeTooltipSuppression(
  document: Document,
): () => void {
  const view = document.defaultView;
  const root = document.documentElement;
  if (!view || !root) return () => undefined;

  suppressNativeTooltips(document);
  const observer = new view.MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        suppressNativeTooltipElement(record.target as Element);
        continue;
      }
      if (record.type === "characterData") {
        const parent = record.target.parentElement;
        if (parent) suppressNativeTooltipElement(parent);
        continue;
      }
      if (record.target instanceof view.Element) {
        suppressNativeTooltipElement(record.target);
      }
      for (const node of record.addedNodes) {
        if (node.nodeType === view.Node.ELEMENT_NODE) {
          suppressNativeTooltips(node as Element);
        }
      }
    }
  });
  observer.observe(root, NATIVE_TOOLTIP_OBSERVER_OPTIONS);

  const suppressHoveredAncestors = (event: MouseEvent) => {
    if (!(event.target instanceof view.Element)) return;
    let element: Element | null = event.target;
    while (element) {
      suppressNativeTooltipElement(element);
      element = element.parentElement;
    }
  };
  document.addEventListener("mouseover", suppressHoveredAncestors, true);

  return () => {
    observer.disconnect();
    document.removeEventListener("mouseover", suppressHoveredAncestors, true);
  };
}

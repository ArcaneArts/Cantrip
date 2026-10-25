const eventName = "cantrip:workspace-window-route";

/** Switch presentation in the same JavaScript context after protected import.
 * A reload here would discard the source before the owned renderer attaches. */
export function activateWorkspaceWindowRoute(search: string) {
  const url = new URL(window.location.href);
  url.search = search;
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event(eventName));
}

export const readWorkspaceWindowRoute = () => window.location.search;
export function subscribeWorkspaceWindowRoute(listener: () => void) {
  window.addEventListener(eventName, listener);
  window.addEventListener("popstate", listener);
  return () => {
    window.removeEventListener(eventName, listener);
    window.removeEventListener("popstate", listener);
  };
}

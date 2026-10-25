import { afterEach, expect, it, vi } from "vitest";
import {
  activateWorkspaceWindowRoute,
  readWorkspaceWindowRoute,
  subscribeWorkspaceWindowRoute,
} from "./workspace-window-route";

afterEach(() => vi.unstubAllGlobals());
it("replaces only the route and notifies the existing renderer without reloading", () => {
  const target = new EventTarget();
  const location = {
    href: "https://cantrip.invalid/app?explorer=old#anchor",
    search: "?explorer=old",
  };
  const state = { router: "retained" };
  const replaceState = vi.fn((_state, _title, url: URL) => {
    location.href = url.href;
    location.search = url.search;
  });
  vi.stubGlobal("window", {
    location,
    history: { state, replaceState },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  });
  const listener = vi.fn();
  const stop = subscribeWorkspaceWindowRoute(listener);
  activateWorkspaceWindowRoute("?cantrip-popout-pane=imported&project=project");
  expect(replaceState.mock.calls[0]![0]).toBe(state);
  expect(location.href).toBe(
    "https://cantrip.invalid/app?cantrip-popout-pane=imported&project=project#anchor",
  );
  expect(readWorkspaceWindowRoute()).toBe(
    "?cantrip-popout-pane=imported&project=project",
  );
  expect(listener).toHaveBeenCalledOnce();
  stop();
  target.dispatchEvent(new Event("popstate"));
  expect(listener).toHaveBeenCalledOnce();
});

import { lazy } from "react";

export const TerminalView = lazy(() =>
  import("@/components/terminal/terminal-view").then((module) => ({
    default: module.TerminalView,
  })),
);

export const PersistentTerminalViews = lazy(() =>
  import("@/components/terminal/persistent-terminal-views").then((module) => ({
    default: module.PersistentTerminalViews,
  })),
);

export const RunTerminalView = lazy(() =>
  import("@/components/terminal/run-terminal-view").then((module) => ({
    default: module.RunTerminalView,
  })),
);

export const PersistentExplorerViews = lazy(() =>
  import("@/components/explorer/persistent-explorer-views").then((module) => ({
    default: module.PersistentExplorerViews,
  })),
);

export const BrowserView = lazy(() =>
  import("@/components/browser/browser-view").then((module) => ({
    default: module.BrowserView,
  })),
);

export const PersistentCodeViews = lazy(() =>
  import("@/components/code/persistent-code-views").then((module) => ({
    default: module.PersistentCodeViews,
  })),
);

export const RemoteDesktopView = lazy(() =>
  import("@/components/remote-desktop/remote-desktop-view").then((module) => ({
    default: module.RemoteDesktopView,
  })),
);

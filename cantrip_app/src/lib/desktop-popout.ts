import { invoke, isTauri } from "@tauri-apps/api/core";
import type { BackgroundThrottlingPolicy } from "@tauri-apps/api/window";

export type DesktopPopoutGroupTarget = {
  activeTabKey: string;
  groupId: string;
  projectId: string;
};

export type DesktopExplorerFileTarget = {
  explorerId: string;
  path: string;
  projectId: string;
};

const groupParameter = "cantrip-popout-group";
const explorerFileParameter = "cantrip-explorer-file";
const noDesktopPopoutListener = () => undefined;

export type DesktopPopoutWindowLifecycle = {
  listenDestroyed(listener: () => void): Promise<() => void>;
};

// Cantrip windows host live transports and Tauri's title-bar drag handling.
// Suspending an occluded WKWebView can therefore freeze both content and
// window interaction until a native resize wakes the document again.
export const desktopBackgroundThrottlingPolicy =
  "disabled" as BackgroundThrottlingPolicy;

export function parseDesktopPopoutGroupTarget(
  search: string,
): DesktopPopoutGroupTarget | null {
  const parameters = new URLSearchParams(search);
  const groupId = parameters.get(groupParameter);
  const projectId = parameters.get("project");
  const activeTabKey = parameters.get("active");
  return groupId && projectId && activeTabKey
    ? { activeTabKey, groupId, projectId }
    : null;
}

export function desktopPopoutGroupSearch(
  target: DesktopPopoutGroupTarget,
): string {
  const parameters = new URLSearchParams({
    [groupParameter]: target.groupId,
    active: target.activeTabKey,
    project: target.projectId,
  });
  return `?${parameters.toString()}`;
}

export function parseDesktopExplorerFileTarget(
  search: string,
): DesktopExplorerFileTarget | null {
  const parameters = new URLSearchParams(search);
  const explorerId = parameters.get("explorer");
  const path = parameters.get(explorerFileParameter);
  const projectId = parameters.get("project");
  return explorerId && path && projectId
    ? { explorerId, path, projectId }
    : null;
}

export function desktopExplorerFileSearch(
  target: DesktopExplorerFileTarget,
): string {
  const parameters = new URLSearchParams({
    [explorerFileParameter]: target.path,
    explorer: target.explorerId,
    project: target.projectId,
  });
  return `?${parameters.toString()}`;
}

export function desktopPopoutGroupWindowLabel(groupId: string): string {
  return `cantrip-group-${groupId.replace(/[^A-Za-z0-9-/:_]/g, "_")}`;
}

function stableLabelHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function desktopExplorerFileWindowLabel(
  explorerId: string,
  path: string,
): string {
  const safeExplorerId = explorerId
    .replace(/[^A-Za-z0-9-/:_]/g, "_")
    .slice(0, 64);
  return `cantrip-editor-${safeExplorerId}-${stableLabelHash(path)}`;
}

export function isDesktopRuntime(): boolean {
  return isTauri();
}

export function isMacosDesktopRuntime(): boolean {
  return shouldUseOverlayTitlebar(isDesktopRuntime(), navigator.userAgent);
}

export async function updateMacosProMode(enabled: boolean): Promise<boolean> {
  if (!isMacosDesktopRuntime()) return false;
  return invoke<boolean>("set_macos_pro_mode", { enabled });
}

export function shouldUseOverlayTitlebar(
  desktopRuntime: boolean,
  userAgent: string,
): boolean {
  return (
    desktopRuntime &&
    (userAgent.includes("Macintosh") || userAgent.includes("Mac OS X"))
  );
}

export function desktopPopoutTitlebarLeftInset(
  popout: boolean,
  overlayTitlebar: boolean,
): string | undefined {
  return popout && overlayTitlebar ? "5.5rem" : undefined;
}

export async function updateDesktopWindowTitle(title: string): Promise<void> {
  if (!isDesktopRuntime()) return;
  document.title = title;
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().setTitle(title);
}

export async function updateDesktopWindowTheme(
  theme: "dark" | "light",
): Promise<void> {
  if (!isDesktopRuntime()) return;
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().setTheme(theme);
}

async function focusWindow(label: string): Promise<boolean> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(label);
  if (!existing) return false;
  await existing.show();
  await existing.unminimize();
  await existing.setFocus();
  return true;
}

export async function focusDesktopPopoutGroup(
  groupId: string,
): Promise<boolean> {
  return isDesktopRuntime()
    ? focusWindow(desktopPopoutGroupWindowLabel(groupId))
    : false;
}

export async function observeDesktopPopoutClosure(
  getWindow: () => Promise<DesktopPopoutWindowLifecycle | null>,
  onClosed: () => void,
): Promise<() => void> {
  const popout = await getWindow();
  if (!popout) {
    onClosed();
    return noDesktopPopoutListener;
  }

  let listening = true;
  const resume = () => {
    if (!listening) return;
    listening = false;
    onClosed();
  };
  const unlisten = await popout.listenDestroyed(resume);
  try {
    if (await getWindow()) {
      return () => {
        if (!listening) return;
        listening = false;
        unlisten();
      };
    }
  } catch (error) {
    unlisten();
    throw error;
  }
  unlisten();
  resume();
  return noDesktopPopoutListener;
}

export async function watchDesktopPopoutGroup(
  groupId: string,
  onClosed: () => void,
): Promise<() => void> {
  if (!isDesktopRuntime()) return noDesktopPopoutListener;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const label = desktopPopoutGroupWindowLabel(groupId);
  return observeDesktopPopoutClosure(async () => {
    const popout = await WebviewWindow.getByLabel(label);
    return popout
      ? {
          listenDestroyed: (listener) =>
            popout.once("tauri://destroyed", listener),
        }
      : null;
  }, onClosed);
}

export async function closeCurrentDesktopWindow(): Promise<void> {
  if (!isDesktopRuntime()) return;
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().close();
}

export async function openDesktopPopoutGroup(
  target: DesktopPopoutGroupTarget,
  title: string,
  position?: { x: number; y: number },
): Promise<"created" | "focused"> {
  return openDesktopWindow(
    desktopPopoutGroupWindowLabel(target.groupId),
    desktopPopoutGroupSearch(target),
    title,
    position,
  );
}

export async function openDesktopExplorerFile(
  target: DesktopExplorerFileTarget,
  title: string,
): Promise<"created" | "focused"> {
  return openDesktopWindow(
    desktopExplorerFileWindowLabel(target.explorerId, target.path),
    desktopExplorerFileSearch(target),
    title,
  );
}

async function openDesktopWindow(
  label: string,
  search: string,
  title: string,
  position?: { x: number; y: number },
): Promise<"created" | "focused"> {
  if (!isDesktopRuntime()) {
    throw new Error("Pop-out windows are only available in the desktop app.");
  }
  if (await focusWindow(label)) return "focused";

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const path = window.location.pathname || "/";
  const macos = isMacosDesktopRuntime();
  const popout = new WebviewWindow(label, {
    backgroundThrottling: desktopBackgroundThrottlingPolicy,
    center: true,
    focus: true,
    height: 760,
    hiddenTitle: macos,
    minHeight: 440,
    minWidth: 640,
    resizable: true,
    title: `${title} — Cantrip`,
    titleBarStyle: macos ? "overlay" : undefined,
    transparent: macos,
    url: `${path}${search}`,
    width: 1100,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      void popout.once("tauri://created", () => resolve());
      void popout.once<unknown>("tauri://error", (event) => {
        reject(
          new Error(
            typeof event.payload === "string"
              ? event.payload
              : "The desktop window could not be created.",
          ),
        );
      });
    });
    if (position) {
      const { PhysicalPosition } = await import("@tauri-apps/api/dpi");
      await popout.setPosition(
        new PhysicalPosition(
          Math.round(position.x - 180),
          Math.round(position.y - 24),
        ),
      );
    }
    return "created";
  } catch (error) {
    // Two callers may race after both observe no owner. The stable label lets
    // the loser recover by focusing the window that won instead of surfacing a
    // duplicate-window error.
    if (await focusWindow(label)) return "focused";
    throw error;
  }
}

import { isTauri } from "@tauri-apps/api/core";

export type DesktopPopoutTarget = {
  kind: "browser" | "chat" | "code" | "explorer" | "terminal" | "view";
  projectId: string;
  tabId: string;
};

const targetParameter = "cantrip-popout";

export function parseDesktopPopoutTarget(
  search: string,
): DesktopPopoutTarget | null {
  const parameters = new URLSearchParams(search);
  const kind = parameters.get(targetParameter);
  const projectId = parameters.get("project");
  if (!projectId) return null;

  if (
    kind !== "browser" &&
    kind !== "chat" &&
    kind !== "code" &&
    kind !== "explorer" &&
    kind !== "terminal" &&
    kind !== "view"
  ) {
    return null;
  }

  const tabId = parameters.get("tab");
  return tabId ? { kind, projectId, tabId } : null;
}

export function desktopPopoutSearch(target: DesktopPopoutTarget): string {
  const parameters = new URLSearchParams({
    [targetParameter]: target.kind,
    project: target.projectId,
  });
  parameters.set("tab", target.tabId);
  return `?${parameters.toString()}`;
}

export function isDesktopRuntime(): boolean {
  return isTauri();
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

export async function openDesktopPopout(
  target: DesktopPopoutTarget,
  title: string,
): Promise<void> {
  if (!isDesktopRuntime()) {
    throw new Error("Pop-out windows are only available in the desktop app.");
  }

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const label = `popout-${target.kind}-${crypto.randomUUID()}`;
  const path = window.location.pathname || "/";
  const popout = new WebviewWindow(label, {
    center: true,
    focus: true,
    height: 760,
    minHeight: 440,
    minWidth: 640,
    resizable: true,
    title: `${title} — Cantrip`,
    url: `${path}${desktopPopoutSearch(target)}`,
    width: 1100,
  });

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
}

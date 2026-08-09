import type { ProjectSurface } from "./project-surface";

export type DesktopPhysicalPosition = { x: number; y: number };

export type DesktopNativeDropResolution =
  | { kind: "cancelled" }
  | { kind: "detach"; screenX: number; screenY: number }
  | {
      kind: "dock";
      targetGroupId: string;
      targetMemberPosition: number;
      targetProjectId: string;
      targetWindowLabel: string;
    }
  | { kind: "invalid"; reason: string }
  | { kind: "noop" };

export type DesktopNativeDragStart = {
  mode: "move-window" | "preview";
  sourceWindowLabel: string;
};

export type DesktopNativeTabDrag = {
  groupId: string;
  projectId: string;
  sourceGroupSize: number;
  sourceIsPopout: boolean;
  surface: {
    kind: ProjectSurface["kind"];
    tabKey: string;
    title: string;
  };
};

type CursorPosition = { x: number; y: number };

const previewLabel = "cantrip-tab-drag-preview";
const previewParameter = "cantrip-tab-drag-preview";
const previewKinds = new Set<ProjectSurface["kind"]>([
  "browser",
  "chat",
  "code",
  "explorer",
  "history",
  "issues",
  "remote-desktop",
  "terminal",
]);

async function invoke<T>(command: string, args?: Record<string, unknown>) {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(command, args);
}

export function parseDesktopTabDragPreview(search: string): {
  kind: ProjectSurface["kind"];
  theme: "dark" | "light";
  title: string;
} | null {
  const parameters = new URLSearchParams(search);
  if (parameters.get(previewParameter) !== "1") return null;
  const title = parameters.get("title");
  const kind = parameters.get("kind") as ProjectSurface["kind"] | null;
  if (!title || !kind || !previewKinds.has(kind)) return null;
  return {
    kind,
    theme: parameters.get("theme") === "dark" ? "dark" : "light",
    title,
  };
}

function previewSearch(surface: DesktopNativeTabDrag["surface"]): string {
  const parameters = new URLSearchParams({
    [previewParameter]: "1",
    kind: surface.kind,
    theme: document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
    title: surface.title,
  });
  return `?${parameters.toString()}`;
}

async function closePreview(): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const preview = await WebviewWindow.getByLabel(previewLabel);
  if (preview) await preview.close();
}

async function positionPreview(): Promise<void> {
  const [{ PhysicalPosition }, { WebviewWindow }] = await Promise.all([
    import("@tauri-apps/api/dpi"),
    import("@tauri-apps/api/webviewWindow"),
  ]);
  const [cursor, preview] = await Promise.all([
    invoke<CursorPosition>("native_tab_drag_cursor"),
    WebviewWindow.getByLabel(previewLabel),
  ]);
  if (preview) {
    await preview.setPosition(
      new PhysicalPosition(
        Math.round(cursor.x + 14),
        Math.round(cursor.y + 14),
      ),
    );
  }
}

async function openPreview(
  surface: DesktopNativeTabDrag["surface"],
): Promise<void> {
  await closePreview();
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const path = window.location.pathname || "/";
  const preview = new WebviewWindow(previewLabel, {
    alwaysOnTop: true,
    decorations: false,
    focus: false,
    focusable: false,
    height: 44,
    resizable: false,
    shadow: true,
    skipTaskbar: true,
    title: surface.title,
    url: `${path}${previewSearch(surface)}`,
    width: 260,
  });
  await new Promise<void>((resolve, reject) => {
    void preview.once("tauri://created", () => resolve());
    void preview.once<unknown>("tauri://error", (event) =>
      reject(
        new Error(
          typeof event.payload === "string"
            ? event.payload
            : "The tab drag preview could not be created.",
        ),
      ),
    );
  });
  await positionPreview();
}

export async function beginDesktopNativeTabDrag(
  drag: DesktopNativeTabDrag,
): Promise<DesktopNativeDragStart> {
  const started = await invoke<DesktopNativeDragStart>(
    "begin_native_tab_drag",
    {
      groupId: drag.groupId,
      projectId: drag.projectId,
      sourceGroupSize: drag.sourceGroupSize,
      sourceIsPopout: drag.sourceIsPopout,
      tabKey: drag.surface.tabKey,
    },
  );
  if (started.mode === "preview") await openPreview(drag.surface);
  return started;
}

export async function moveDesktopNativeTabDragPreview(): Promise<void> {
  await positionPreview();
}

export async function startDesktopNativeWindowDrag(): Promise<void> {
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().startDragging();
}

export async function finishDesktopNativeTabDrag(): Promise<DesktopNativeDropResolution> {
  try {
    return await invoke<DesktopNativeDropResolution>("finish_native_tab_drag");
  } finally {
    await closePreview().catch(() => undefined);
  }
}

export async function cancelDesktopNativeTabDrag(): Promise<void> {
  await Promise.allSettled([invoke("cancel_native_tab_drag"), closePreview()]);
}

export async function focusDesktopWindow(label: string): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const target = await WebviewWindow.getByLabel(label);
  if (!target) return;
  await target.show();
  await target.unminimize();
  await target.setFocus();
}

export async function watchDesktopTopBar(
  element: HTMLElement,
  projectId: string,
  groupId: string,
): Promise<() => void> {
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  const currentWindow = getCurrentWebviewWindow();
  const registrationId = crypto.randomUUID();
  let disposed = false;
  let frame: number | null = null;
  const register = () => {
    if (disposed || frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      if (disposed || !element.isConnected) return;
      const rect = element.getBoundingClientRect();
      const tabs = [
        ...element.querySelectorAll<HTMLElement>("[data-project-tab-key]"),
      ].map((tab) => {
        const tabRect = tab.getBoundingClientRect();
        return {
          left: tabRect.left,
          right: tabRect.right,
          tabKey: tab.dataset.projectTabKey!,
        };
      });
      void invoke("register_tab_top_bar", {
        groupId,
        projectId,
        registrationId,
        rect: {
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          top: rect.top,
        },
        tabs,
      }).catch((error) =>
        console.error("Could not register the desktop tab bar", error),
      );
    });
  };
  const observer = new ResizeObserver(register);
  observer.observe(element);
  const mutations = new MutationObserver(register);
  mutations.observe(element, {
    attributeFilter: ["style", "class"],
    attributes: true,
    childList: true,
    subtree: true,
  });
  element.addEventListener("scroll", register, { passive: true });
  window.addEventListener("resize", register);
  const unlistenMoved = await currentWindow.onMoved(register);
  const unlistenResized = await currentWindow.onResized(register);
  const unlistenScaleChanged = await currentWindow.onScaleChanged(register);
  register();
  return () => {
    disposed = true;
    if (frame !== null) window.cancelAnimationFrame(frame);
    observer.disconnect();
    mutations.disconnect();
    element.removeEventListener("scroll", register);
    window.removeEventListener("resize", register);
    unlistenMoved();
    unlistenResized();
    unlistenScaleChanged();
    void invoke("unregister_tab_top_bar", { registrationId }).catch(
      () => undefined,
    );
  };
}

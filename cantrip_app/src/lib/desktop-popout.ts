import { invoke, isTauri } from "@tauri-apps/api/core";
import type { CodeAppearance, ExplorerSummary } from "@cantrip/protocol";
import type { BackgroundThrottlingPolicy } from "@tauri-apps/api/window";

import type { DesktopExplorerWindowBroker } from "@/lib/desktop-explorer-window-broker";
import { desktopExplorerWindowLaunchParameter } from "@/lib/desktop-explorer-window-protocol";
import { clientLogger } from "@/lib/client-log-relay";
import { clientEncryption } from "@/lib/client-encryption";
import { getWorkers } from "@/lib/api";
import { getClientSession } from "@/lib/client-session";
import {
  isProjectOverviewSection,
  type ProjectOverviewSection,
} from "@/lib/project-overview-section";
import { waitForSurfacePrivateStateWorkerEncryption } from "@/lib/surface-private-state-worker-encryption";

export type DesktopPopoutGroupTarget = {
  activeTabKey: string;
  groupId: string;
  projectId: string;
};

export type DesktopProjectOverviewTarget = {
  projectId: string;
  section: ProjectOverviewSection;
  worktreeId: string | null;
};

export type DesktopExplorerFileTarget = {
  explorerId: string;
  path: string;
  projectId: string;
};

export type DesktopExplorerFileRouteTarget = DesktopExplorerFileTarget & {
  launchId: string | null;
};

export type DesktopStandaloneChatFileTarget = {
  chatId: string;
  path: string;
};

export type DesktopExplorerFileLaunchContext = {
  appearance: CodeAppearance;
  explorer: ExplorerSummary;
  projectTitle?: string;
};

const groupParameter = "cantrip-popout-group";
const projectOverviewParameter = "cantrip-project-overview";
const explorerFileParameter = "cantrip-explorer-file";
const standaloneChatFileParameter = "cantrip-chat-file";
const standaloneChatIdParameter = "cantrip-chat-id";
const syntheticBuildProgressParameter = "cantrip-synthetic-build";
const noDesktopListener = () => undefined;
type ExplorerWindowBrokerRegistration = {
  broker: DesktopExplorerWindowBroker;
  disposePromise?: Promise<void>;
  identityEpoch: string;
};

const explorerWindowBrokers = new Map<
  string,
  ExplorerWindowBrokerRegistration
>();
const explorerFileWindowLabels = new Map<string, string>();
const explorerFileOpenOperations = new Map<
  string,
  { path: string; promise: Promise<"created" | "focused"> }
>();
const explorerEditorPrewarmPath = ".cantrip-editor-prewarm";
let explorerWindowUnloadCleanupInstalled = false;
let explorerWindowIdentitySubscriptionInstalled = false;
let currentExplorerEditorIdentityEpoch: string | null = null;

type ExplorerEditorWarmSlot = {
  broker: DesktopExplorerWindowBroker;
  identityEpoch: string;
  key: string;
  label: string;
  registration: ExplorerWindowBrokerRegistration;
};

type ExplorerEditorWarmState = {
  controller: AbortController;
  identityEpoch: string;
  key: string;
  promise: Promise<ExplorerEditorWarmSlot>;
  retired: boolean;
};

let explorerEditorWarmState: ExplorerEditorWarmState | null = null;

export type DesktopPopoutWindowLifecycle = {
  listenDestroyed(listener: () => void): Promise<() => void>;
};

export type DesktopWindowFocusLifecycle = {
  listenFocusChanged(listener: (focused: boolean) => void): Promise<() => void>;
};

export type DesktopWindowTheme = "dark" | "light" | null;

type DesktopWindowOpenBehavior = {
  focus?: boolean;
  visible?: boolean;
};

export function isSyntheticBuildProgressWindow(search: string): boolean {
  return (
    new URLSearchParams(search).get(syntheticBuildProgressParameter) ===
    "progress"
  );
}

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

export function parseDesktopProjectOverviewTarget(
  search: string,
): DesktopProjectOverviewTarget | null {
  const parameters = new URLSearchParams(search);
  const projectId = parameters.get("project");
  const section = parameters.get(projectOverviewParameter);
  return projectId && isProjectOverviewSection(section)
    ? {
        projectId,
        section,
        worktreeId: parameters.get("worktree"),
      }
    : null;
}

export function desktopProjectOverviewSearch(
  target: DesktopProjectOverviewTarget,
): string {
  const parameters = new URLSearchParams({
    [projectOverviewParameter]: target.section,
    project: target.projectId,
  });
  if (target.worktreeId) parameters.set("worktree", target.worktreeId);
  return `?${parameters.toString()}`;
}

export function parseDesktopExplorerFileTarget(
  search: string,
): DesktopExplorerFileRouteTarget | null {
  const parameters = new URLSearchParams(search);
  const explorerId = parameters.get("explorer");
  const path = parameters.get(explorerFileParameter);
  const projectId = parameters.get("project");
  return explorerId && path && projectId
    ? {
        explorerId,
        launchId: parameters.get(desktopExplorerWindowLaunchParameter),
        path,
        projectId,
      }
    : null;
}

export function desktopExplorerFileSearch(
  target: DesktopExplorerFileTarget,
  launchId?: string,
): string {
  const parameters = new URLSearchParams({
    [explorerFileParameter]: target.path,
    explorer: target.explorerId,
    project: target.projectId,
  });
  if (launchId) {
    parameters.set(desktopExplorerWindowLaunchParameter, launchId);
  }
  return `?${parameters.toString()}`;
}

export function parseDesktopStandaloneChatFileTarget(
  search: string,
): DesktopStandaloneChatFileTarget | null {
  const parameters = new URLSearchParams(search);
  const chatId = parameters.get(standaloneChatIdParameter);
  const path = parameters.get(standaloneChatFileParameter);
  return chatId && path ? { chatId, path } : null;
}

export function desktopStandaloneChatFileSearch(
  target: DesktopStandaloneChatFileTarget,
): string {
  const parameters = new URLSearchParams({
    [standaloneChatFileParameter]: target.path,
    [standaloneChatIdParameter]: target.chatId,
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

export function desktopProjectOverviewWindowLabel(
  target: DesktopProjectOverviewTarget,
): string {
  const project = target.projectId
    .replace(/[^A-Za-z0-9-/:_]/g, "_")
    .slice(0, 64);
  return `cantrip-overview-${project}-${target.section}-${stableLabelHash(target.worktreeId ?? "primary")}`;
}

export function desktopExplorerFileWindowLabel(
  explorerId: string,
  path: string,
  worktreeId?: string,
  workerId?: string,
  identityEpoch?: string,
): string {
  const safeExplorerId = explorerId
    .replace(/[^A-Za-z0-9-/:_]/g, "_")
    .slice(0, 64);
  const binding =
    identityEpoch !== undefined
      ? `${worktreeId ?? ""}\0${workerId ?? ""}\0${identityEpoch ?? ""}`
      : worktreeId || workerId
        ? `${worktreeId ?? ""}\0${workerId ?? ""}`
        : path;
  return `cantrip-editor-${safeExplorerId}-${stableLabelHash(binding)}`;
}

export function desktopStandaloneChatFileWindowLabel(
  target: DesktopStandaloneChatFileTarget,
): string {
  return `cantrip-chat-file-${stableLabelHash(`${target.chatId}\0${target.path}`)}`;
}

function desktopExplorerFileTargetKey(
  target: DesktopExplorerFileTarget,
  context: DesktopExplorerFileLaunchContext,
  identityEpoch: string,
): string {
  return [
    target.explorerId,
    context.explorer.worktreeId,
    context.explorer.activeWorkerId,
    identityEpoch,
  ].join("\0");
}

function desktopExplorerEditorWarmKey(
  context: DesktopExplorerFileLaunchContext,
  identityEpoch: string,
): string {
  return [
    context.explorer.id,
    context.explorer.projectId,
    context.explorer.worktreeId,
    context.explorer.activeWorkerId,
    context.appearance,
    identityEpoch,
  ].join("\0");
}

function desktopExplorerEditorWarmWindowLabel(
  warmKey: string,
  launchId: string,
): string {
  return `cantrip-editor-warm-${stableLabelHash(`${warmKey}\0${launchId}`)}`;
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

export function desktopWindowThemeOverride(
  preference: "dark" | "light" | "system",
): DesktopWindowTheme {
  return preference === "system" ? null : preference;
}

export async function updateDesktopWindowTheme(
  theme: DesktopWindowTheme,
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

async function closeWindow(label: string): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(label);
  if (!existing) return;
  await existing.close();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await WebviewWindow.getByLabel(label))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The previous Explorer editor window did not close.");
}

async function disposeExplorerWindowBroker(
  label: string,
  registration: ExplorerWindowBrokerRegistration,
): Promise<void> {
  if (explorerWindowBrokers.get(label) === registration) {
    explorerWindowBrokers.delete(label);
  }
  for (const [targetKey, targetLabel] of explorerFileWindowLabels) {
    if (targetLabel === label) explorerFileWindowLabels.delete(targetKey);
  }
  registration.disposePromise ??= registration.broker.dispose();
  await registration.disposePromise;
}

async function closeExplorerEditorWarmSlot(
  slot: ExplorerEditorWarmSlot,
): Promise<void> {
  await closeWindow(slot.label).catch(() => undefined);
  await disposeExplorerWindowBroker(slot.label, slot.registration);
}

function retireExplorerEditorWarmState(state: ExplorerEditorWarmState): void {
  if (state.retired) return;
  state.retired = true;
  state.controller.abort(
    new DOMException("Explorer editor prewarm was superseded.", "AbortError"),
  );
  void state.promise
    .then((slot) => closeExplorerEditorWarmSlot(slot))
    .catch(() => undefined);
}

function explorerEditorIdentityEpoch(): {
  key: string;
  ready: boolean;
} {
  const session = getClientSession();
  const snapshot = clientEncryption.getSnapshot();
  const ready = Boolean(
    session &&
    snapshot.status === "ready" &&
    snapshot.identity?.serverId === session.serverId &&
    snapshot.identity.ownerId === session.user.id &&
    snapshot.masterKeyRevision,
  );
  return {
    key: JSON.stringify([
      1,
      session?.serverId ?? null,
      session?.user.id ?? null,
      snapshot.status,
      snapshot.identity?.serverId ?? null,
      snapshot.identity?.ownerId ?? null,
      snapshot.clientId,
      snapshot.masterKeyRevision,
    ]),
    ready,
  };
}

function disposeExplorerEditorIdentityEpoch(): void {
  if (explorerEditorWarmState) {
    retireExplorerEditorWarmState(explorerEditorWarmState);
    explorerEditorWarmState = null;
  }
  explorerFileOpenOperations.clear();
  explorerFileWindowLabels.clear();
  const registrations = [...explorerWindowBrokers.entries()];
  explorerWindowBrokers.clear();
  for (const [label, registration] of registrations) {
    void closeWindow(label)
      .catch(() => undefined)
      .then(() => disposeExplorerWindowBroker(label, registration));
  }
}

function reconcileExplorerEditorIdentityEpoch(): {
  key: string;
  ready: boolean;
} {
  const epoch = explorerEditorIdentityEpoch();
  if (currentExplorerEditorIdentityEpoch === null) {
    currentExplorerEditorIdentityEpoch = epoch.key;
  } else if (currentExplorerEditorIdentityEpoch !== epoch.key) {
    currentExplorerEditorIdentityEpoch = epoch.key;
    disposeExplorerEditorIdentityEpoch();
  }
  return epoch;
}

function explorerEditorIdentityEpochIsCurrent(identityEpoch: string): boolean {
  const current = reconcileExplorerEditorIdentityEpoch();
  return current.ready && current.key === identityEpoch;
}

async function waitForExplorerEditorSurfaceReadiness(
  workerId: string,
  identityEpoch: string,
  signal: AbortSignal,
): Promise<void> {
  await waitForSurfacePrivateStateWorkerEncryption({
    isCancelled: () =>
      signal.aborted || !explorerEditorIdentityEpochIsCurrent(identityEpoch),
    loadWorker: async () =>
      (await getWorkers()).find((worker) => worker.workerId === workerId),
  });
  signal.throwIfAborted();
  if (!explorerEditorIdentityEpochIsCurrent(identityEpoch)) {
    throw new DOMException(
      "Explorer editor identity changed during prewarm.",
      "AbortError",
    );
  }
}

function installExplorerWindowUnloadCleanup(): void {
  if (explorerWindowUnloadCleanupInstalled) return;
  explorerWindowUnloadCleanupInstalled = true;
  window.addEventListener(
    "pagehide",
    () => {
      if (explorerEditorWarmState) {
        retireExplorerEditorWarmState(explorerEditorWarmState);
        explorerEditorWarmState = null;
      }
      const registrations = [...explorerWindowBrokers.values()];
      explorerWindowBrokers.clear();
      explorerFileWindowLabels.clear();
      for (const registration of registrations) {
        void registration.broker.dispose();
      }
    },
    { once: true },
  );
  if (!explorerWindowIdentitySubscriptionInstalled) {
    explorerWindowIdentitySubscriptionInstalled = true;
    currentExplorerEditorIdentityEpoch = explorerEditorIdentityEpoch().key;
    clientEncryption.subscribe(() => {
      reconcileExplorerEditorIdentityEpoch();
    });
  }
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
    return noDesktopListener;
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
  return noDesktopListener;
}

export async function watchDesktopPopoutGroup(
  groupId: string,
  onClosed: () => void,
): Promise<() => void> {
  if (!isDesktopRuntime()) return noDesktopListener;
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

export async function observeDesktopWindowFocus(
  getWindow: () => Promise<DesktopWindowFocusLifecycle | null>,
  onFocused: () => void,
): Promise<() => void> {
  const currentWindow = await getWindow();
  if (!currentWindow) return noDesktopListener;
  return currentWindow.listenFocusChanged((focused) => {
    if (focused) onFocused();
  });
}

export async function watchDesktopWindowFocus(
  onFocused: () => void,
): Promise<() => void> {
  if (!isDesktopRuntime()) return noDesktopListener;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return observeDesktopWindowFocus(async () => {
    const currentWindow = getCurrentWindow();
    return {
      listenFocusChanged: (listener) =>
        currentWindow.onFocusChanged(({ payload }) => listener(payload)),
    };
  }, onFocused);
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

export async function openDesktopProjectOverviewPopout(
  target: DesktopProjectOverviewTarget,
  title: string,
  position?: { x: number; y: number },
): Promise<"created" | "focused"> {
  return openDesktopWindow(
    desktopProjectOverviewWindowLabel(target),
    desktopProjectOverviewSearch(target),
    title,
    position,
  );
}

export async function openDesktopStandaloneChatFile(
  target: DesktopStandaloneChatFileTarget,
  title: string,
): Promise<"created" | "focused"> {
  return openDesktopWindow(
    desktopStandaloneChatFileWindowLabel(target),
    desktopStandaloneChatFileSearch(target),
    title,
    undefined,
    { height: 760, minHeight: 440, minWidth: 640, width: 1100 },
  );
}

async function createExplorerEditorWarmSlot(
  context: DesktopExplorerFileLaunchContext,
  identityEpoch: string,
  key: string,
  signal: AbortSignal,
): Promise<ExplorerEditorWarmSlot> {
  const startedAt = Date.now();
  // The protected-attachment API establishes tunnel-content readiness before
  // posting the attachment. Establish the Explorer's surface grants first so
  // automatic prewarm cannot allocate against stale server/account state.
  await waitForExplorerEditorSurfaceReadiness(
    context.explorer.activeWorkerId,
    identityEpoch,
    signal,
  );
  const { createDesktopExplorerWindowBroker } =
    await import("@/lib/desktop-explorer-window-broker");
  signal.throwIfAborted();
  if (!explorerEditorIdentityEpochIsCurrent(identityEpoch)) {
    throw new DOMException(
      "Explorer editor identity changed during prewarm.",
      "AbortError",
    );
  }
  const broker = createDesktopExplorerWindowBroker(
    {
      ...context,
      path: explorerEditorPrewarmPath,
    },
    { configureInitialFile: false, signal },
  );
  const label = desktopExplorerEditorWarmWindowLabel(key, broker.launchId);
  const registration = { broker, identityEpoch };
  const slot = { broker, identityEpoch, key, label, registration };
  explorerWindowBrokers.set(label, registration);
  try {
    signal.throwIfAborted();
    await openDesktopWindow(
      label,
      desktopExplorerFileSearch(
        {
          explorerId: context.explorer.id,
          path: explorerEditorPrewarmPath,
          projectId: context.explorer.projectId,
        },
        broker.launchId,
      ),
      "Editor",
      undefined,
      undefined,
      { focus: false, visible: false },
    );
    signal.throwIfAborted();
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    signal.throwIfAborted();
    const popout = await WebviewWindow.getByLabel(label);
    if (!popout) {
      throw new Error("The prewarmed Explorer editor window closed.");
    }
    await popout.once("tauri://destroyed", () => {
      void disposeExplorerWindowBroker(label, registration);
    });
    await broker.ready;
    signal.throwIfAborted();
    if (!explorerEditorIdentityEpochIsCurrent(identityEpoch)) {
      throw new DOMException(
        "Explorer editor identity changed during prewarm.",
        "AbortError",
      );
    }
    clientLogger.info("Explorer editor bridge prewarmed", {
      durationMs: Date.now() - startedAt,
      event: "surface.explorer.editor-window.prewarmed",
      operation: "prewarm-editor",
      status: "ready",
      subsystem: "explorer",
      surfaceId: context.explorer.id,
    });
    return slot;
  } catch (error) {
    await closeExplorerEditorWarmSlot(slot);
    throw error;
  }
}

export async function prewarmDesktopExplorerFile(
  context: DesktopExplorerFileLaunchContext,
): Promise<void> {
  if (!isDesktopRuntime()) return;
  installExplorerWindowUnloadCleanup();
  const identity = reconcileExplorerEditorIdentityEpoch();
  if (!identity.ready) {
    clearDesktopExplorerFilePrewarm();
    return;
  }
  const key = desktopExplorerEditorWarmKey(context, identity.key);
  if (explorerEditorWarmState?.key === key) {
    await explorerEditorWarmState.promise.catch(() => undefined);
    return;
  }
  if (explorerEditorWarmState) {
    retireExplorerEditorWarmState(explorerEditorWarmState);
  }
  const state: ExplorerEditorWarmState = {
    controller: new AbortController(),
    identityEpoch: identity.key,
    key,
    promise: Promise.resolve(null as never),
    retired: false,
  };
  state.promise = createExplorerEditorWarmSlot(
    context,
    identity.key,
    key,
    state.controller.signal,
  );
  explorerEditorWarmState = state;
  await state.promise.catch((error: unknown) => {
    if (explorerEditorWarmState === state) explorerEditorWarmState = null;
    clientLogger.debug("Explorer editor prewarm was unavailable", {
      event: "surface.explorer.editor-window.prewarm-unavailable",
      operation: "prewarm-editor",
      reasonCode: state.retired ? "superseded" : "prewarm-failed",
      status: state.retired ? "cancelled" : "degraded",
      subsystem: "explorer",
      surfaceId: context.explorer.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function clearDesktopExplorerFilePrewarm(): void {
  if (!explorerEditorWarmState) return;
  retireExplorerEditorWarmState(explorerEditorWarmState);
  explorerEditorWarmState = null;
}

async function takeExplorerEditorWarmSlot(
  context: DesktopExplorerFileLaunchContext,
  identityEpoch: string,
): Promise<ExplorerEditorWarmSlot | null> {
  const key = desktopExplorerEditorWarmKey(context, identityEpoch);
  const state = explorerEditorWarmState;
  if (
    !state ||
    state.identityEpoch !== identityEpoch ||
    state.key !== key ||
    state.retired
  ) {
    return null;
  }
  explorerEditorWarmState = null;
  const slot = await state.promise.catch(() => null);
  if (
    !slot ||
    slot.identityEpoch !== identityEpoch ||
    !explorerEditorIdentityEpochIsCurrent(identityEpoch)
  ) {
    if (slot) await closeExplorerEditorWarmSlot(slot);
    return null;
  }
  return slot;
}

export function openDesktopExplorerFile(
  target: DesktopExplorerFileTarget,
  title: string,
  context: DesktopExplorerFileLaunchContext,
): Promise<"created" | "focused"> {
  installExplorerWindowUnloadCleanup();
  const identity = reconcileExplorerEditorIdentityEpoch();
  if (!identity.ready) {
    return Promise.reject(
      new Error("Encryption must be unlocked for this account."),
    );
  }
  const targetKey = desktopExplorerFileTargetKey(target, context, identity.key);
  const current = explorerFileOpenOperations.get(targetKey);
  if (current?.path === target.path) return current.promise;
  const operation = (current?.promise ?? Promise.resolve("focused" as const))
    .catch(() => "focused" as const)
    .then(() =>
      openDesktopExplorerFileOperation(
        target,
        title,
        context,
        targetKey,
        identity.key,
      ),
    )
    .finally(() => {
      if (explorerFileOpenOperations.get(targetKey)?.promise === operation) {
        explorerFileOpenOperations.delete(targetKey);
      }
    });
  explorerFileOpenOperations.set(targetKey, {
    path: target.path,
    promise: operation,
  });
  return operation;
}

async function openDesktopExplorerFileOperation(
  target: DesktopExplorerFileTarget,
  title: string,
  context: DesktopExplorerFileLaunchContext,
  targetKey: string,
  identityEpoch: string,
): Promise<"created" | "focused"> {
  installExplorerWindowUnloadCleanup();
  if (!explorerEditorIdentityEpochIsCurrent(identityEpoch)) {
    throw new Error("Explorer editor identity changed before opening.");
  }
  const legacyLabel = desktopExplorerFileWindowLabel(
    target.explorerId,
    target.path,
    context.explorer.worktreeId,
    context.explorer.activeWorkerId,
    identityEpoch,
  );
  const activeLabel = explorerFileWindowLabels.get(targetKey) ?? legacyLabel;
  const activeRegistration = explorerWindowBrokers.get(activeLabel);
  const activeBroker =
    activeRegistration?.identityEpoch === identityEpoch
      ? activeRegistration.broker
      : undefined;
  if (activeBroker && !activeBroker.failed) {
    try {
      await activeBroker.openFile(target.path);
      if (!explorerEditorIdentityEpochIsCurrent(identityEpoch)) {
        throw new Error("Explorer editor identity changed while opening.");
      }
      if (await focusWindow(activeLabel)) {
        if (!explorerEditorIdentityEpochIsCurrent(identityEpoch)) {
          throw new Error("Explorer editor identity changed while focusing.");
        }
        return "focused";
      }
    } catch {
      // Replace an editor that can no longer confirm the requested file.
    }
  }
  if (activeBroker) {
    await closeWindow(activeLabel).catch(() => undefined);
    await disposeExplorerWindowBroker(activeLabel, activeRegistration!);
  } else if (activeRegistration) {
    await closeWindow(activeLabel).catch(() => undefined);
    await disposeExplorerWindowBroker(activeLabel, activeRegistration);
  } else if (activeLabel === legacyLabel) {
    // A child can outlive a reloaded main WebView. Its launch channel no
    // longer has an owner, so replace it instead of focusing a permanently
    // disconnected editor window.
    await closeWindow(activeLabel);
  }
  explorerFileWindowLabels.delete(targetKey);

  const requestedAtMs = Date.now();
  const warmSlot = await takeExplorerEditorWarmSlot(context, identityEpoch);
  if (warmSlot) {
    try {
      if (!explorerEditorIdentityEpochIsCurrent(identityEpoch)) {
        throw new Error("Explorer editor identity changed before opening.");
      }
      await warmSlot.broker.openFile(target.path, requestedAtMs);
      if (!explorerEditorIdentityEpochIsCurrent(identityEpoch)) {
        throw new Error("Explorer editor identity changed while opening.");
      }
      const focused = await focusWindow(warmSlot.label);
      if (!explorerEditorIdentityEpochIsCurrent(identityEpoch)) {
        throw new Error("Explorer editor identity changed while focusing.");
      }
      if (!focused) {
        throw new Error("The prewarmed Explorer editor window closed.");
      }
      explorerFileWindowLabels.set(targetKey, warmSlot.label);
      clientLogger.info("Explorer file opened in a prewarmed editor", {
        durationMs: Date.now() - requestedAtMs,
        event: "surface.explorer.editor-window.warm-opened",
        operation: "open-file",
        status: "completed",
        subsystem: "explorer",
        surfaceId: target.explorerId,
      });
      return "created";
    } catch {
      await closeExplorerEditorWarmSlot(warmSlot);
    }
  }

  if (!explorerEditorIdentityEpochIsCurrent(identityEpoch)) {
    throw new Error("Explorer editor identity changed before opening.");
  }
  const label = legacyLabel;
  const { createDesktopExplorerWindowBroker } =
    await import("@/lib/desktop-explorer-window-broker");
  if (!explorerEditorIdentityEpochIsCurrent(identityEpoch)) {
    throw new Error("Explorer editor identity changed before opening.");
  }
  const broker = createDesktopExplorerWindowBroker({
    ...context,
    path: target.path,
  });
  const registration = { broker, identityEpoch };
  explorerWindowBrokers.set(label, registration);
  explorerFileWindowLabels.set(targetKey, label);
  const disposeBroker = async () => {
    await disposeExplorerWindowBroker(label, registration);
  };
  try {
    const result = await openDesktopWindow(
      label,
      desktopExplorerFileSearch(target, broker.launchId),
      title,
    );
    if (result === "focused") {
      await disposeBroker();
      return result;
    }
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const popout = await WebviewWindow.getByLabel(label);
    if (!popout) {
      await disposeBroker();
      throw new Error("The Explorer editor window closed while opening.");
    }
    await popout.once("tauri://destroyed", () => void disposeBroker());
    if (!explorerEditorIdentityEpochIsCurrent(identityEpoch)) {
      await closeWindow(label).catch(() => undefined);
      await disposeBroker();
      throw new Error("Explorer editor identity changed while opening.");
    }
    return result;
  } catch (error) {
    await disposeBroker();
    throw error;
  }
}

export async function openSyntheticBuildProgressWindow(): Promise<
  "created" | "focused"
> {
  return openDesktopWindow(
    "synthetic-build-progress",
    `?${syntheticBuildProgressParameter}=progress`,
    "Building Cantrip",
    undefined,
    { height: 720, minHeight: 520, minWidth: 760, width: 1040 },
  );
}

async function openDesktopWindow(
  label: string,
  search: string,
  title: string,
  position?: { x: number; y: number },
  size?: { height: number; minHeight: number; minWidth: number; width: number },
  behavior: DesktopWindowOpenBehavior = {},
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
    // Tauri's native file-drop handler prevents the webview's HTML5 drop
    // events from receiving File objects on Windows. Chat tabs can live in
    // detached groups, so pop-outs must match the main window configuration.
    dragDropEnabled: false,
    focus: behavior.focus ?? true,
    height: size?.height ?? 760,
    hiddenTitle: macos,
    minHeight: size?.minHeight ?? 440,
    minWidth: size?.minWidth ?? 640,
    resizable: true,
    title: `${title} — Cantrip`,
    titleBarStyle: macos ? "overlay" : undefined,
    transparent: macos,
    url: `${path}${search}`,
    visible: behavior.visible ?? true,
    width: size?.width ?? 1100,
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

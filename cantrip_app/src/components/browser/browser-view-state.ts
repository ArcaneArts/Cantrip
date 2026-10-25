import {
  remoteSurfaceViewportSchema,
  type RemoteSurfaceViewport,
} from "@cantrip/protocol";

/** Private view data is transported only inside the encrypted workspace envelope.
 * Chromium history, page contents and scroll position remain in the worker session. */
export interface BrowserViewState {
  version: 1;
  browserId: string;
  projectId: string;
  workerId: string;
  address: string;
  addressDirty: boolean;
  currentUrl: string;
  invalidAddress: boolean;
  serviceSearch: string;
  currentWorkerId?: string;
  viewport: RemoteSurfaceViewport;
}
export function parseBrowserViewState(
  value: unknown,
  expected: {
    browserId: string;
    projectId: string;
    workerId: string;
  },
): BrowserViewState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid browser view state.");
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    typeof state.address !== "string" ||
    typeof state.currentUrl !== "string" ||
    typeof state.serviceSearch !== "string" ||
    typeof state.addressDirty !== "boolean" ||
    typeof state.invalidAddress !== "boolean" ||
    (state.currentWorkerId !== undefined &&
      typeof state.currentWorkerId !== "string")
  )
    throw new Error("Invalid browser view state.");
  if (
    state.browserId !== expected.browserId ||
    state.projectId !== expected.projectId ||
    state.workerId !== expected.workerId
  )
    throw new Error("Transferred browser does not match its reservation.");
  if (!expected.browserId || !expected.projectId || !expected.workerId)
    throw new Error("Invalid browser transfer owner.");
  return {
    version: 1,
    browserId: expected.browserId,
    projectId: expected.projectId,
    workerId: expected.workerId,
    address: state.address,
    addressDirty: state.addressDirty,
    currentUrl: state.currentUrl,
    invalidAddress: state.invalidAddress,
    serviceSearch: state.serviceSearch,
    ...(typeof state.currentWorkerId === "string"
      ? { currentWorkerId: state.currentWorkerId }
      : {}),
    viewport: remoteSurfaceViewportSchema.parse(state.viewport),
  };
}

export interface BrowserTransferLifecycle {
  suspendTransfer(): () => void;
  captureTransfer(): Promise<BrowserViewState>;
  retireTransfer(): Promise<void>;
}
export interface BrowserTransferStaging {
  onRestored(): void;
  onError(error: unknown): void;
}

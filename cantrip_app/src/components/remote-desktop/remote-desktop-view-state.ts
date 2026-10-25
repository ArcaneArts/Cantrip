import {
  remoteSurfaceViewportSchema,
  type RemoteDesktopSummary,
} from "@cantrip/protocol";
import { z } from "zod";

/** Renderer-only state carried inside the encrypted workspace transfer envelope.
 * The worker owns the desktop target and session; input epochs must never move
 * between attachments. A destination obtains its own epoch after attaching. */
const remoteDesktopViewStateSchema = z
  .object({
    version: z.literal(1),
    desktopId: z.string().min(1),
    projectId: z.string().min(1),
    workerId: z.string().min(1),
    viewport: remoteSurfaceViewportSchema,
    fleetOpen: z.boolean(),
    targetSearch: z.string(),
  })
  .strict();

export type RemoteDesktopViewState = z.infer<
  typeof remoteDesktopViewStateSchema
>;
export interface RemoteDesktopTransferOwner {
  tabId: string;
  desktopId: string;
  projectId: string;
  workerId: string;
}

export function parseRemoteDesktopViewState(
  value: unknown,
  expected: Omit<RemoteDesktopTransferOwner, "tabId">,
): RemoteDesktopViewState {
  const state = remoteDesktopViewStateSchema.parse(value);
  if (
    state.desktopId !== expected.desktopId ||
    state.projectId !== expected.projectId ||
    state.workerId !== expected.workerId
  ) {
    throw new Error(
      "Transferred remote desktop does not match its reservation.",
    );
  }
  return state;
}

export interface RemoteDesktopTransferLifecycle {
  suspendTransfer(): () => void;
  captureTransfer(): Promise<RemoteDesktopViewState>;
  retireTransfer(): Promise<void>;
}

export interface RemoteDesktopTransferStaging {
  onRestored(): void;
  onError(error: unknown): void;
}

export interface IncomingRemoteDesktopView {
  tabId: string;
  desktop: RemoteDesktopSummary;
  state: RemoteDesktopViewState;
  staging?: RemoteDesktopTransferStaging;
}

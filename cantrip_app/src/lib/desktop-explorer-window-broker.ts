import type { DesktopExplorerWindowContext } from "./desktop-explorer-window-protocol";
import { createNativeExplorerWindowBroker } from "./native-explorer-window-broker";

export interface DesktopExplorerWindowBroker {
  dispose(): Promise<void>;
  readonly failed: boolean;
  launchId: string;
  openFile(path: string, requestedAtMs?: number): Promise<void>;
  ready: Promise<void>;
}
export interface DesktopExplorerWindowBrokerOptions {
  signal?: AbortSignal;
}

export function createDesktopExplorerWindowBroker(
  input: Omit<DesktopExplorerWindowContext, "requestedAtMs">,
  options: DesktopExplorerWindowBrokerOptions = {},
): DesktopExplorerWindowBroker {
  return createNativeExplorerWindowBroker(input, options);
}

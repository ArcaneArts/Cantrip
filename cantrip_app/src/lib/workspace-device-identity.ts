import type { ClientSessionIdentitySnapshot } from "./client-session";
import type { InstallationCatalogReader } from "./installation-catalog";
import { detectClientRuntimePlatform } from "./runtime-platform";

/** Installation identity survives reload/login; viewport and session epochs do
 * not belong in placement identity. Hash a framed tuple so route parameters
 * stay bounded even when scope components contain long URLs or Unicode. */
export async function workspaceDeviceIdentity(
  installationId: string,
  identity: Pick<ClientSessionIdentitySnapshot, "serverId" | "userId">,
  projectId: string,
) {
  const parts = [installationId, identity.serverId, identity.userId, projectId];
  if (parts.some((part) => !part))
    throw new Error("Workspace identity is incomplete.");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify(["cantrip-workspace-v1", ...parts]),
    ),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const workspaceId = `workspace:v1:${hash}`;
  return { workspaceId, mainWindowId: `main:${workspaceId}` };
}

async function installationCatalog(): Promise<InstallationCatalogReader> {
  const platform = detectClientRuntimePlatform();
  if (platform === "browser") {
    const { openBrowserInstallationStorage } =
      await import("./browser-installation-storage");
    return (await openBrowserInstallationStorage()).catalog;
  }
  const { openNativeInstallationStorage } =
    await import("./native-installation-storage");
  return (await openNativeInstallationStorage(platform)).catalog;
}

/** Reuse the durable installation already established by account startup. Do
 * not manufacture a volatile fallback that would orphan the saved workspace. */
export async function readWorkspaceDeviceIdentity(
  identity: Pick<ClientSessionIdentitySnapshot, "serverId" | "userId">,
  projectId: string,
  catalog: () => Promise<InstallationCatalogReader> = installationCatalog,
) {
  const profile = await (await catalog()).getInstallation();
  if (!profile) throw new Error("The durable installation is not initialized.");
  return workspaceDeviceIdentity(profile.installationId, identity, projectId);
}

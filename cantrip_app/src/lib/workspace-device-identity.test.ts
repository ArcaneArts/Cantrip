import { expect, it, vi } from "vitest";
import {
  readWorkspaceDeviceIdentity,
  workspaceDeviceIdentity,
} from "./workspace-device-identity";
import { MemoryInstallationCatalog } from "./installation-catalog";

const account = { serverId: "server", userId: "owner" };
it.each([
  "12345678-1234-1234-1234-123456789abc",
  "https://server.example/" + "界:/%".repeat(1000),
])(
  "keeps encoded routing identities within the router limit",
  async (scope) => {
    const result = await workspaceDeviceIdentity(
      scope,
      { serverId: scope, userId: scope },
      scope,
    );
    expect(result.workspaceId).toMatch(/^workspace:v1:[a-f0-9]{64}$/);
    expect(encodeURIComponent(result.workspaceId).length).toBeLessThanOrEqual(
      100,
    );
    expect(encodeURIComponent(result.mainWindowId).length).toBeLessThanOrEqual(
      100,
    );
  },
);
it("keeps placement identity stable across reloads and session changes", async () => {
  expect(await workspaceDeviceIdentity("install", account, "project")).toEqual(
    await workspaceDeviceIdentity("install", { ...account }, "project"),
  );
});
it("isolates devices, accounts, servers and projects", async () => {
  const identities = await Promise.all([
    workspaceDeviceIdentity("one", account, "project"),
    workspaceDeviceIdentity("two", account, "project"),
    workspaceDeviceIdentity("one", { ...account, userId: "other" }, "project"),
    workspaceDeviceIdentity(
      "one",
      { ...account, serverId: "other" },
      "project",
    ),
    workspaceDeviceIdentity("one", account, "other"),
  ]);
  expect(new Set(identities.map((x) => x.workspaceId)).size).toBe(5);
  expect(new Set(identities.map((x) => x.mainWindowId)).size).toBe(5);
});
it("cannot alias delimiters between scope components", async () => {
  expect(await workspaceDeviceIdentity("a:b", account, "c")).not.toEqual(
    await workspaceDeviceIdentity("a", account, "b:c"),
  );
  await expect(workspaceDeviceIdentity("", account, "c")).rejects.toThrow(
    "incomplete",
  );
});
it("reads the existing installation without creating or changing one", async () => {
  const catalog = new MemoryInstallationCatalog();
  await catalog.transaction((tx) =>
    tx.createInstallation({
      schemaVersion: 1,
      createdAt: new Date(0).toISOString(),
      installationId: "5f83bb42-5671-4b11-a87f-32842af21af2",
    }),
  );
  const write = vi.spyOn(catalog, "transaction");
  expect(
    await readWorkspaceDeviceIdentity(account, "p", async () => catalog),
  ).toEqual(
    await workspaceDeviceIdentity(
      "5f83bb42-5671-4b11-a87f-32842af21af2",
      account,
      "p",
    ),
  );
  expect(write).not.toHaveBeenCalled();
});
it("reports unavailable/missing storage instead of inventing a new layout", async () => {
  await expect(
    readWorkspaceDeviceIdentity(
      account,
      "p",
      async () => new MemoryInstallationCatalog(),
    ),
  ).rejects.toThrow("not initialized");
  await expect(
    readWorkspaceDeviceIdentity(account, "p", async () => {
      throw new Error("disk unavailable");
    }),
  ).rejects.toThrow("disk unavailable");
});

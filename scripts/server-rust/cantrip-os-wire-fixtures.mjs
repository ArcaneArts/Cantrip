import { cantripOsWorkspaceOperationFixtures } from "./cantrip-os-workspace-operation-fixtures.mjs";
import { osDispatchFixtures } from "./cantrip-os-dispatch-fixtures.mjs";
import { cantripOsDesktopFixtures } from "./cantrip-os-desktop-fixtures.mjs";
import { cantripOsPowerFixtures } from "./cantrip-os-power-fixtures.mjs";
import { worktreeWireFixtures } from "./worktree-wire-fixtures.mjs";

export function cantripOsWireFixtures() {
  const at = "2026-11-03T00:00:00.000Z";
  const transport = { kind: "docker", container: "cantrip-os" };
  const { path: _path, ...worktree } =
    worktreeWireFixtures().projectWorktreeSummarySchema[0];
  const os = {
    id: "instance",
    ownerId: "owner",
    workerId: "worker",
    guestInstanceId: "11111111-1111-4111-8111-111111111111",
    attachmentGeneration: "attachment-1",
    name: "CantripOS",
    status: "connected",
    runtimeGeneration: "runtime-1",
    lastError: null,
    lastObservedAt: at,
    createdAt: at,
    updatedAt: at,
  };
  const profile = {
    guestWorkspaceId: "example",
    uid: 20000,
    gid: 20000,
    homeGuestPath: "/home/example",
  };
  return {
    ...osDispatchFixtures(),
    ...cantripOsPowerFixtures(),
    ...cantripOsDesktopFixtures(),
    ...cantripOsWorkspaceOperationFixtures(),
    cantripOsGuestPathSchema: [
      "/home/example",
      "/literal # % ? 日本語",
      "/unpaired\ud800",
    ],
    projectSourceLocationSchema: [
      { kind: "worker-local", workerPath: "/worker/project" },
      {
        kind: "cantrip-os",
        instanceId: "instance",
        workspaceId: "workspace",
        guestPath: "/home/example/project",
      },
    ],
    cantripOsTransportSchema: [
      transport,
      {
        kind: "ssh",
        host: "localhost",
        port: 2222,
        user: "cantrip",
        identityFile: "/worker/key",
        knownHostsFile: "/worker/known-hosts",
      },
    ],
    cantripOsDependencyOverlaySchema: [
      ...["node_modules", ".venv", "packages/app/node_modules", "\ud800"].map(
        (path) => ({ path }),
      ),
    ],
    cantripOsDependencyOverlaysSchema: [[], [{ path: "node_modules" }]],
    cantripOsAttachSchema: [
      {
        workerId: "worker",
        guestInstanceId: os.guestInstanceId,
        name: "CantripOS",
        transport,
        expectedAttachmentGeneration: null,
      },
    ],
    cantripOsWorkspaceObservationSchema: [profile],
    cantripOsInstanceSummarySchema: [os],
    cantripOsWorkspaceSummarySchema: [
      {
        ...profile,
        id: "workspace",
        instanceId: "instance",
        workerId: "worker",
        createdAt: at,
        updatedAt: at,
      },
    ],
    cantripOsProjectSourceSummarySchema: [
      {
        id: "source",
        projectId: worktree.projectId,
        workerId: "worker",
        sourceKind: "git",
        instanceId: "instance",
        workspaceId: "workspace",
        guestPath: "/home/example/source",
        ownershipKind: "cantrip",
        repositoryFingerprint: null,
        primaryWorktreeId: worktree.id,
        createdAt: at,
        updatedAt: at,
      },
    ],
    cantripOsProjectWorktreeSummarySchema: [
      {
        ...worktree,
        instanceId: "instance",
        workspaceId: "workspace",
        guestPath: "/home/example/source",
      },
    ],
    cantripOsSourceBindingSummarySchema: [
      {
        id: "binding",
        ownerId: "owner",
        projectId: worktree.projectId,
        workerId: "worker",
        projectSourceId: "source",
        worktreeId: worktree.id,
        instanceId: "instance",
        workspaceId: "workspace",
        mode: "linux-owned",
        linkedWorkerPath: null,
        guestPath: "/home/example/source",
        bindingGeneration: "binding-1",
        provisionedAttachmentGeneration: null,
        provisionedRuntimeGeneration: null,
        state: "provisioning",
        lastError: null,
        dependencyOverlays: [],
        createdAt: at,
        updatedAt: at,
      },
    ],
  };
}

export function cantripOsWireCases(name) {
  return (
    {
      cantripOsGuestPathSchema: ["relative", "C:\\project", "/with\0nul"],
      projectSourceLocationSchema: [
        { kind: "cantrip-os", workerPath: "/host/accident" },
      ],
      cantripOsDependencyOverlaySchema: [
        "",
        "/absolute",
        ".",
        "..",
        "a/../b",
        "a//b",
        ".git/objects",
        "null\0path",
      ].map((path) => ({ path })),
      cantripOsDependencyOverlaysSchema: [
        [{ path: "node_modules" }, { path: "node_modules" }],
      ],
    }[name] ?? []
  );
}

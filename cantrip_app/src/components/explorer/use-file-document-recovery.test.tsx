import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExplorerTransferState } from "./explorer-view";
import { useFileDocumentRecovery } from "./use-file-document-recovery";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  checkpoint: vi.fn(),
  dispose: vi.fn(),
  workspace: vi.fn(),
  renewEncryption: vi.fn(),
}));
vi.mock("@/lib/document-recovery-session", () => ({
  DocumentRecoverySession: class {
    load = mocks.load;
    checkpoint = mocks.checkpoint;
    dispose = mocks.dispose;
    renewEncryption = mocks.renewEncryption;
  },
}));
vi.mock("@/lib/workspace-device-identity", () => ({
  readWorkspaceDeviceIdentity: mocks.workspace,
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => ({
    serverId: "server",
    userId: "owner",
  }),
  clientSessionIdentityMatches: () => true,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const document = {
  id: "doc",
  projectId: "project",
  workerId: "worker",
  worktreeId: "tree",
  path: "file.rs",
  createdAt: "2026-10-24T00:00:00Z",
};
let current!: ReturnType<typeof useFileDocumentRecovery>;
let renderer: ReactTestRenderer | undefined;
function Probe({ staging = false }: { staging?: boolean }) {
  current = useFileDocumentRecovery(document, "tab", staging);
  return null;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(null);
  mocks.checkpoint.mockResolvedValue(undefined);
  mocks.renewEncryption.mockResolvedValue(undefined);
  mocks.workspace.mockResolvedValue({ workspaceId: "workspace" });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

it("restores and checkpoints under StrictMode and retains the close finalizer after unmount", async () => {
  await act(async () => {
    renderer = create(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
  });
  expect(current.loaded).toBe(true);
  const state = { explorerId: "tab" } as ExplorerTransferState;
  await act(async () => {
    await current.checkpoint(state);
  });
  expect(mocks.checkpoint).toHaveBeenCalledOnce();
  const close = current.closeCommitted;
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(mocks.checkpoint).toHaveBeenCalledTimes(1);
  await close();
  expect(mocks.checkpoint).toHaveBeenLastCalledWith(null);
  await expect(current.checkpoint(state)).rejects.toThrow(
    "Document view was closed",
  );
  expect(mocks.checkpoint).toHaveBeenCalledTimes(2);
});

it("does not load or write a destination recovery revision while staged", async () => {
  await act(async () => {
    renderer = create(<Probe staging />);
  });
  await current.checkpoint({ explorerId: "tab" } as ExplorerTransferState);
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.checkpoint).not.toHaveBeenCalled();
  await act(async () => {
    renderer!.update(<Probe />);
  });
  expect(current.loaded).toBe(true);
  expect(mocks.load).toHaveBeenCalledOnce();
  await act(async () => {
    await current.checkpoint({ explorerId: "tab" } as ExplorerTransferState);
  });
  expect(mocks.checkpoint).toHaveBeenCalledOnce();
});

it("retains a failed restore as an error and retries the actual load", async () => {
  mocks.load.mockRejectedValueOnce(new Error("cannot decrypt"));
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(current.loaded).toBe(false);
  expect(current.error).toBe("cannot decrypt");
  expect(mocks.checkpoint).not.toHaveBeenCalled();
  await act(async () => current.retry());
  expect(current.loaded).toBe(true);
  expect(current.error).toBeUndefined();
  expect(mocks.load).toHaveBeenCalledTimes(2);
});

it("renews encryption before retrying the latest live checkpoint without restoring again", async () => {
  await act(async () => {
    renderer = create(<Probe />);
  });
  mocks.checkpoint.mockRejectedValueOnce(new Error("encryption changed"));
  await act(async () => {
    await expect(
      current.checkpoint({
        explorerId: "latest draft",
      } as ExplorerTransferState),
    ).rejects.toThrow("encryption changed");
  });
  expect(current.error).toBe("encryption changed");
  await act(async () => current.retry());
  expect(mocks.renewEncryption).toHaveBeenCalledOnce();
  expect(mocks.checkpoint).toHaveBeenCalledTimes(2);
  expect(mocks.load).toHaveBeenCalledOnce();
  expect(current.error).toBeUndefined();
});

it("does not retry a checkpoint when renewal reports another writer's revision", async () => {
  await act(async () => {
    renderer = create(<Probe />);
  });
  await act(async () => {
    await current.checkpoint({ explorerId: "draft" } as ExplorerTransferState);
  });
  mocks.renewEncryption.mockRejectedValueOnce(
    new Error("another renderer wrote"),
  );
  await act(async () => current.retry());
  expect(mocks.checkpoint).toHaveBeenCalledOnce();
  expect(mocks.load).toHaveBeenCalledOnce();
  expect(current.error).toBe("another renderer wrote");
});

it("reports recovery pending until the actual checkpoint settles", async () => {
  await act(async () => {
    renderer = create(<Probe />);
  });
  let finish!: () => void;
  mocks.checkpoint.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = current.checkpoint({
      explorerId: "draft",
    } as ExplorerTransferState);
  });
  expect(current.pending).toBe(true);
  await act(async () => {
    finish();
    await pending;
  });
  expect(current.pending).toBe(false);
});

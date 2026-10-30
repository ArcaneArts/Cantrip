import { tunnelRecord } from "./tunnel-record-fixture.mjs";
export function projectShareWireFixtures() {
  const id = "11111111-1111-4111-8111-111111111111",
    other = "22222222-2222-4222-8222-222222222222";
  const input = {
    tunnelId: id,
    workerId: "worker",
    protectedRecord: { ...tunnelRecord, operationId: id },
  };
  const attachment = {
    attachmentId: id,
    projectId: "project",
    protocol: "webdav",
    tunnelId: id,
    expiresAt: "2026-10-25T00:00:00.000Z",
    mountLeaseMs: 43200000,
  };
  return {
    projectShareTunnelCreateSchema: [
      input,
      { ...input, worktreeId: "worktree" },
      {
        ...input,
        workerId: "\ud800",
        protectedRecord: {
          ...input.protectedRecord,
          operationId: other,
          revision: 2,
        },
      },
    ],
    projectShareAttachmentWireSchema: [
      attachment,
      { ...attachment, mountLeaseMs: 1 },
    ],
    standaloneChatShareAttachmentWireSchema: [
      {
        attachmentId: id,
        chatId: other,
        protocol: "webdav",
        tunnelId: id,
        expiresAt: attachment.expiresAt,
        mountLeaseMs: 86400000,
      },
    ],
    workerProjectShareOpenResultSchema: [{ accepted: true, shareId: id }],
  };
}

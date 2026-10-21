// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  session: { serverId: "server-one", user: { id: "account-one" } },
  changed: null as (() => void) | null,
}));
vi.mock("@/lib/client-session", () => ({
  getClientSession: () => auth.session,
  onClientSessionIdentityChanged: (listener: () => void) => {
    auth.changed = listener;
    return () => {
      auth.changed = null;
    };
  },
}));
import {
  chatEditorSessions,
  chatFileDocumentId,
  retainedChatFileBinding,
} from "./standalone-chat-editor-sessions";

beforeEach(() => {
  chatEditorSessions.discardAll();
  auth.session = { serverId: "server-one", user: { id: "account-one" } };
});

describe("Chat editor lifetime", () => {
  it("keeps a dirty draft bound to its original scratch root and protects hidden drafts on unload", () => {
    const binding = { workerId: "worker-one", scratchRootId: "scratch-one" };
    const document = chatEditorSessions.open(
      chatFileDocumentId("chat", "notes", binding),
      "disk",
      "v1",
    );
    document.edit("draft");
    expect(retainedChatFileBinding("chat", "notes")).toEqual(binding);
    expect(retainedChatFileBinding("other-chat", "notes")).toBeNull();
    expect(retainedChatFileBinding("chat", "other-file")).toBeNull();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    chatEditorSessions.discard(document.id);
    expect(retainedChatFileBinding("chat", "notes")).toBeNull();
  });

  it("isolates account/server lookups and clears endpoint memory on identity changes without a mounted preview", () => {
    const binding = { workerId: "worker-one", scratchRootId: "scratch-one" };
    const id = chatFileDocumentId("chat", "notes", binding);
    chatEditorSessions.open(id, "disk", "v1").edit("private draft");
    auth.session = { serverId: "server-one", user: { id: "account-two" } };
    expect(retainedChatFileBinding("chat", "notes")).toBeNull();
    auth.session = { serverId: "server-two", user: { id: "account-one" } };
    expect(retainedChatFileBinding("chat", "notes")).toBeNull();
    auth.changed!();
    expect(chatEditorSessions.get(id)).toBeUndefined();
    expect(chatEditorSessions.hasDirtyDocuments).toBe(false);
  });
});

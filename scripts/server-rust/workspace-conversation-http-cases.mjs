import assert from "node:assert/strict";
import { workspaceTab } from "./workspace-wire-fixtures.mjs";
import { label } from "./project-target-state.mjs";

export async function workspaceConversationHttpCases(visit, document) {
  const base = "/api/projects/github/workspace-layouts/conversations";
  const headers = { "x-cantrip-workspace-version": "2" };
  let layout = await visit("conversation seed", "POST", base + "/seed", {
    json: { mainWindowId: "conversation-main" },
  });
  let sequence = 0;
  const command = (action) => ({
    operationId: `conversation-${sequence++}`,
    workspaceId: "conversations",
    projectId: "github",
    windowId: "conversation-main",
    attachmentGeneration: layout.windows.find(
      (w) => w.id === "conversation-main",
    ).attachmentGeneration,
    expectedRevision: layout.revision,
    action,
  });
  const action = (resourceId) => ({
    type: "open-conversation",
    view: workspaceTab("direct", resourceId, "project.agent"),
    newPaneId: "direct-pane",
    splitId: "direct-split",
  });
  const open = command(action("chat"));
  const denied = await visit(
    "old client cannot upgrade",
    "POST",
    base + "/commands",
    { json: open, status: 409 },
  );
  assert.equal(denied.code, "version");
  assert.deepEqual(denied.supportedVersions, [1, 2]);
  assert.equal(denied.requiredVersion, 2);
  assert.deepEqual(
    await visit("old client rejected without mutation", "GET", base),
    layout,
  );
  for (const id of [
    "other-chat",
    "task-conversation",
    "standalone-conversation",
    "archived-conversation",
  ]) {
    const result = await visit(
      `reject ineligible conversation ${id}`,
      "POST",
      base + "/commands",
      { json: command(action(id)), headers, status: 409 },
    );
    assert.equal(result.code, "missing");
  }
  const opened = await visit(
    "new client opens direct conversation",
    "POST",
    base + "/commands",
    { json: open, headers },
  );
  layout = opened.layout;
  assert.equal(layout.version, 2);
  const pane = layout.windows[0].panes.find(
    (p) => p.conversationView?.id === "direct",
  );
  assert.ok(pane);
  assert.deepEqual(pane.conversationView.titleProtection, label("chat"));
  assert.ok(!pane.tabs.some((tab) => tab.id === "direct"));
  await visit("old client cannot read version two", "GET", base, {
    status: 409,
  });
  await visit("old seed cannot read version two", "POST", base + "/seed", {
    json: { mainWindowId: "conversation-main" },
    status: 409,
  });
  await visit(
    "old client cannot mutate version two",
    "POST",
    base + "/commands",
    { json: command({ type: "home" }), status: 409 },
  );
  const replay = await visit(
    "new client replays canonical direct receipt",
    "POST",
    base + "/commands",
    { json: open, headers },
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.layout, layout);
  assert.deepEqual(
    await visit("version two unchanged after old clients", "GET", base, {
      headers,
    }),
    layout,
  );
  const closed = await visit(
    "close direct conversation",
    "POST",
    base + "/commands",
    {
      json: command({ type: "close-conversation", viewId: "direct" }),
      headers,
    },
  );
  assert.ok(
    closed.layout.windows.every((w) =>
      w.panes.every((p) => !p.conversationView),
    ),
  );
  const importedRequest = {
    windowId: "cantrip-editor-conversation-import",
    paneId: "imported",
    expectedRevision: closed.layout.revision,
    views: [{ tabId: "imported-file", documentId: document, mode: "edit" }],
  };
  await visit(
    "old client cannot import into version two",
    "POST",
    base + "/import-legacy-files",
    { json: importedRequest, status: 409 },
  );
  const imported = await visit(
    "new client imports into version two",
    "POST",
    base + "/import-legacy-files",
    { json: importedRequest, headers },
  );
  const importedPane = imported.layout.windows.find(
    (w) => w.id === importedRequest.windowId,
  ).panes[0];
  assert.equal(importedPane.conversationView, null);
  assert.deepEqual(importedPane.selection, {
    kind: "tab",
    tabId: "imported-file",
  });
}

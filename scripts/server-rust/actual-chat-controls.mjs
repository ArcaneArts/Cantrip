// Existing encrypted browser SDK -> actual server -> production Git/Codex
// worker. Only the public model HTTP response is controlled.
import assert from "node:assert/strict";
import { readdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./full-worker.mjs";

async function compactedJournal(workerDirectory, threadId, summary) {
  const directory = path.join(workerDirectory, "codex-home", "sessions");
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(`-${threadId}.jsonl`)) continue;
    const file = path.join(entry.parentPath, entry.name);
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.pop();
    const records = lines.map((line) => JSON.parse(line));
    const identity = records.find((r) => r.type === "session_meta");
    assert.equal(identity.payload.id, threadId);
    const checkpoint = records.find(
      (r) =>
        r.type === "compacted" &&
        typeof r.payload.message === "string" &&
        r.payload.message.endsWith("\n" + summary),
    );
    if (checkpoint) return { file, identity, checkpoint };
  }
  return null;
}

export async function actualChatControls({
  page,
  fixture,
  projectId,
  chatId,
  workerDataDirectory,
  configuration,
  readMessages,
  idle,
  model,
  startWorker,
  stopWorker,
  result,
  requests,
}) {
  const api = (operation, args = []) =>
    page.evaluate(
      async ({ operation, args }) => {
        return (await import("/src/lib/api/chats.ts"))[operation](...args);
      },
      { operation, args },
    );
  const trees = (operation, args = []) =>
    page.evaluate(
      async ({ operation, args }) => {
        return (await import("/src/lib/api/worktrees.ts"))[operation](...args);
      },
      { operation, args },
    );
  const postCount = () =>
    model.requests.filter((r) => r.method === "POST").length;
  const baselinePosts = postCount();
  assert.equal(
    baselinePosts,
    4,
    "full Agent/Goal baseline completed before controls",
  );
  const before = await readMessages();
  const thread = before
    .flatMap((m) => m.content)
    .find((i) => i.type === "text" && i.correlation?.threadId)
    ?.correlation.threadId;
  assert.ok(thread);
  const summary = "Private actual compaction checkpoint 🌌";
  const compactReply = model.reply({ text: summary });
  result.chatControls = { phase: "compaction", chatId, threadId: thread };
  assert.deepEqual(await api("compactChat", [chatId]), { accepted: true });
  await eventually(
    () => compactReply.request,
    (r) => assert.equal(r?.completed, true),
  );
  const journal = await eventually(
    () => compactedJournal(workerDataDirectory, thread, summary),
    (r) =>
      assert.ok(r, "actual native rollout persisted the compaction checkpoint"),
  );
  assert.equal(postCount(), baselinePosts + 1);
  await idle();
  result.steps.push(
    "existing browser compactChat SDK drives actual native compaction and the original thread persists its model-produced checkpoint",
  );
  result.chatControls.phase = "continuation";

  const prompt = "Private turn after compaction 🌿",
    answer = "Private native answer after compaction 🌻";
  const continuation = model.reply({ text: answer });
  const admitted = await api("startTurn", [chatId, prompt, configuration]);
  assert.equal(admitted.status, "queued");
  const resumedMessages = await eventually(readMessages, (messages) => {
    const continuationMessages = messages.filter((m) =>
      m.content.some((i) => i.type === "text" && i.text === answer),
    );
    assert.equal(continuationMessages.length, 1);
    assert.equal(continuationMessages[0].modelId, configuration.modelId);
    const text = continuationMessages[0].content.find(
      (i) => i.type === "text" && i.text === answer,
    );
    assert.equal(text.correlation.sourceMethod, "native-history");
    assert.equal(text.streaming, false);
    const compacted = messages.find((m) =>
      m.content.some(
        (i) => i.type === "activity" && i.activity.type === "contextCompaction",
      ),
    );
    assert.ok(compacted, "compaction has a canonical archived activity");
    assert.equal(compacted.modelId, configuration.modelId);
    const activity = compacted.content.find(
      (i) => i.type === "activity" && i.activity.type === "contextCompaction",
    ).activity;
    assert.equal(activity.correlation.sourceMethod, "native-history");
    assert.equal(activity.status, "completed");
  });
  assert.equal(continuation.request.completed, true);
  assert.ok(
    JSON.stringify(continuation.request.input).includes(summary),
    "real native continuation uses the compacted context",
  );
  assert.equal(postCount(), baselinePosts + 2);
  await idle();
  result.steps.push(
    "the full native runtime executes another encrypted Agent turn using its compacted context",
  );

  const initial = await trees("getProjectWorktrees", [projectId]);
  result.chatControls.phase = "worktree-selection-and-release";
  const primary = initial.find((w) => w.isPrimary);
  assert.ok(primary);
  const name = "private-chat-control-worktree",
    branch = "private-chat-control-branch";
  const created = await trees("createProjectWorktree", [
    projectId,
    {
      name,
      sourceWorktreeId: primary.id,
      mode: { type: "newBranch", branch, startPoint: "HEAD" },
    },
  ]);
  assert.equal(created.lifecycleState, "ready");
  const closedConsoles = await page.evaluate(
    async ({ projectId, chatId }) => {
      const terminals = await import("/src/lib/api/terminals.ts");
      const linked = (await terminals.getTerminals(projectId)).filter(
        (t) => t.linkedChatId === chatId,
      );
      for (const console of linked) await terminals.deleteTerminal(console.id);
      return linked.map((t) => t.id);
    },
    { projectId, chatId },
  );
  const selected = await api("updateChatWorktree", [
    chatId,
    { worktreeId: created.id, mode: "pinned" },
  ]);
  assert.equal(selected.activeWorktreeId, created.id);
  assert.equal(selected.worktreeMode, "pinned");
  const selectedLanes = await api("getChatExecutionLanes", [chatId]);
  const lane = selectedLanes.find(
    (l) => l.worktreeId === created.id && l.state !== "released",
  );
  assert.ok(lane);
  assert.equal(lane.state, "suspended");
  assert.equal(lane.exclusive, true);
  const dirty = path.join(created.path, "private-chat-control-dirty.txt"),
    bytes = "Private dirty work survives lane release.\n";
  await writeFile(dirty, bytes);
  await assert.rejects(
    api("releaseChatExecutionLane", [
      chatId,
      lane.id,
      { allowDirty: false, returnToPrimary: true },
    ]),
    /uncommitted changes/,
  );
  assert.equal(await readFile(dirty, "utf8"), bytes);
  assert.equal(
    (await api("getChatExecutionLanes", [chatId])).find((l) => l.id === lane.id)
      .state,
    "suspended",
  );
  result.steps.push(
    "existing worktree/lane SDKs select a real Git checkout and reject releasing its dirty lane without changing files or lane state",
  );

  await api("releaseChatExecutionLane", [
    chatId,
    lane.id,
    { allowDirty: true, returnToPrimary: true },
  ]);
  const released = await api("getChatExecutionLanes", [chatId]);
  assert.equal(released.find((l) => l.id === lane.id).state, "released");
  assert.ok(released.find((l) => l.id === lane.id).releasedAt);
  const chats = await api("getChats", [projectId]);
  assert.equal(chats.find((c) => c.id === chatId).activeWorktreeId, primary.id);
  assert.equal(
    chats.find((c) => c.id === chatId).worktreeMode,
    "agent-managed",
  );
  const releasedMessages = await eventually(readMessages, (messages) => {
    const additions = messages.filter(
      (m) => !resumedMessages.some((old) => old.id === m.id),
    );
    assert.equal(
      additions.length,
      1,
      "release appends one actual protected system message",
    );
    assert.equal(additions[0].role, "system");
    assert.equal(additions[0].executionLaneId, lane.id);
    assert.equal(additions[0].worktreeId, created.id);
    assert.ok(
      additions[0].content.some(
        (i) =>
          i.type === "text" &&
          i.text.startsWith("Released ") &&
          i.text.endsWith("; execution returned to Primary."),
      ),
      "browser decrypts the worker-protected attributed release message",
    );
  });
  await api("releaseChatExecutionLane", [
    chatId,
    lane.id,
    { allowDirty: false, returnToPrimary: true },
  ]);
  const releaseMessages = (messages) =>
    messages.filter(
      (m) => m.executionLaneId === lane.id && m.role === "system",
    );
  assert.equal(releaseMessages(releasedMessages).length, 1);
  assert.deepEqual(
    releaseMessages(await readMessages()),
    releaseMessages(releasedMessages),
    "replay retains exactly the same attributed release message",
  );
  assert.equal(
    await readFile(dirty, "utf8"),
    bytes,
    "release preserves actual dirty checkout bytes",
  );
  result.steps.push(
    "allowDirty releases the actual lane, returns Chat to Primary, preserves dirty files and delivers exactly one browser-decrypted attributed system message across replay",
  );

  const port = Number(new URL(fixture.server.origin).port);
  await stopWorker();
  // Shutdown drains canonical ingestion. Capture that committed representation,
  // including exact attribution, before requiring byte-for-byte SDK retention.
  const committedMessages = await readMessages();
  assert.deepEqual(
    releaseMessages(committedMessages),
    releaseMessages(releasedMessages),
  );
  await fixture.close();
  await fixture.start({ port });
  assert.deepEqual(await api("getChatExecutionLanes", [chatId]), released);
  assert.deepEqual(await readMessages(), committedMessages);
  await startWorker();
  assert.deepEqual(await readMessages(), committedMessages);
  const synchronized = await api("syncChat", [chatId]);
  assert.equal(synchronized.threadId, thread);
  assert.equal(synchronized.status, "idle");
  assert.equal(
    postCount(),
    baselinePosts + 2,
    "restart/sync does not repeat native inference or compaction",
  );
  assert.ok(await compactedJournal(workerDataDirectory, thread, summary));
  await rm(dirty);
  await trees("removeProjectWorktree", [
    projectId,
    created.id,
    { allowExternal: false, force: false },
  ]);
  result.steps.push(
    "server/full-worker restart retains released lane, encrypted transcript, Primary runtime identity and native compaction checkpoint without repeating inference",
  );
  for (const secret of [
    summary,
    prompt,
    answer,
    name,
    branch,
    created.path,
    bytes,
  ]) {
    assert.equal(
      JSON.stringify(requests).includes(secret),
      false,
      "private control content stays out of browser-to-server requests",
    );
    assert.equal(
      fixture.server.diagnostics().includes(secret),
      false,
      "private control content stays out of server diagnostics",
    );
  }
  assert.deepEqual(model.failures, []);
  result.chatControls = {
    completed: true,
    chatId,
    threadId: thread,
    primaryWorktreeId: primary.id,
    releasedLaneId: lane.id,
    worktreeId: created.id,
    compactedJournal: journal,
    nativeModelPosts: postCount() - baselinePosts,
    dirtyBytesRetained: true,
    encryptedMessageRetainedAcrossReplayAndRestart: true,
    closedConsoles,
  };
}

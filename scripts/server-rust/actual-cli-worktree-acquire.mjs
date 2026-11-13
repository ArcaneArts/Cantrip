// A real CLI command runs against the thread binding from an active native turn.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { eventually } from "./full-worker.mjs";

const execute = promisify(execFile);

export async function actualCliWorktreeAcquire({
  page,
  fixture,
  projectId,
  projectRoot,
  workerDataDirectory,
  chat,
  configuration,
  model,
  cliBinary,
  startWorker,
  stopWorker,
  result,
}) {
  const name = "CLI continuation checkout";
  const branch = "cli-continuation-checkout";
  const initialText = "The CLI source turn finished.";
  const continuationText = "The CLI destination turn finished.";
  const read = (operation, ...args) =>
    page.evaluate(
      async ({ operation, args }) =>
        (await import("/src/lib/api/chats.ts"))[operation](...args),
      { operation, args },
    );
  const getChat = async () =>
    (await read("getChats", projectId)).find(({ id }) => id === chat.id);
  const lanes = () => read("getChatExecutionLanes", chat.id);
  const messages = () => read("getMessages", chat.id);
  const proof = (result.cliWorktreeAcquire = {
    chatId: chat.id,
    phase: "source-turn",
  });
  const initial = model.reply({ text: initialText, hold: true });
  const continuationReply = model.reply({ text: continuationText });
  try {
    const admitted = await read(
      "startTurn",
      chat.id,
      "Wait for a CLI worktree transition.",
      configuration,
    );
    assert.equal(admitted.status, "queued");
    await eventually(
      () => initial.request,
      (request) => assert.ok(request),
      // The installed Windows worker can take longer to start its native
      // runtime and reach the first provider request on an emulated host.
      process.platform === "win32" ? 120_000 : undefined,
    );
    const source = await eventually(lanes, (entries) => {
      const lane = entries.find((entry) => entry.state === "active");
      assert.equal(lane?.worktreeId, chat.activeWorktreeId);
      assert.ok(lane.codexThreadId);
    }).then((entries) => entries.find((entry) => entry.state === "active"));
    proof.sourceLane = source;
    proof.phase = "cli-acquire";
    // Close the linked console through the existing client control. The
    // worktree contract deliberately rejects a switch while it is open.
    proof.closedConsoles = await page.evaluate(
      async ({ projectId, chatId }) => {
        const terminals = await import("/src/lib/api/terminals.ts");
        const linked = (await terminals.getTerminals(projectId)).filter(
          (terminal) => terminal.linkedChatId === chatId,
        );
        for (const terminal of linked)
          await terminals.deleteTerminal(terminal.id);
        return linked.map(({ id }) => id);
      },
      { projectId, chatId: chat.id },
    );
    const { stdout } = await execute(
      cliBinary,
      ["--json", "worktree", "create", name, "--branch", branch, "--switch"],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          CANTRIP_CLI_CONNECTION: path.join(
            workerDataDirectory,
            "cli-connection.json",
          ),
          CODEX_THREAD_ID: source.codexThreadId,
          CANTRIP_TERMINAL_ID: "",
        },
        timeout: 30_000,
      },
    );
    const acquired = (proof.cliResult = JSON.parse(stdout));
    assert.equal(acquired.mutated, true);
    assert.equal(acquired.continuationScheduled, true);
    const { worktree: wireWorktree, lane: pending } = acquired.data;
    assert.equal(acquired.worktreeId, wireWorktree.id);
    const worktrees = () =>
      page.evaluate(async (id) => {
        const api = await import("/src/lib/api/worktrees.ts");
        return api.getProjectWorktrees(id);
      }, projectId);
    const worktree = (
      await eventually(worktrees, (entries) => {
        const tree = entries.find(({ id }) => id === wireWorktree.id);
        assert.equal(tree?.branch, branch);
        assert.notEqual(tree.path, "Protected path unavailable");
      })
    ).find(({ id }) => id === wireWorktree.id);
    assert.equal(pending.worktreeId, worktree.id);
    assert.equal(pending.state, "delivering");
    assert.equal(pending.transitionKind, "switch");
    assert.equal(pending.purpose, `Continue in ${name} from the Cantrip CLI`);
    assert.equal(pending.acquiringActor, "agent");
    assert.equal(pending.exclusive, true);
    assert.equal((await getChat()).activeWorktreeId, source.worktreeId);
    assert.deepEqual(
      (await lanes()).find(({ id }) => id === pending.id),
      pending,
    );
    const checkout = await realpath(worktree.path);
    const git = async (...args) =>
      (await execute("git", ["-C", checkout, ...args])).stdout.trim();
    assert.equal(await git("branch", "--show-current"), branch);
    assert.equal(
      await readFile(path.join(checkout, "retained.txt"), "utf8"),
      "Existing user file remains intact.\n",
    );
    result.steps.push(
      "packaged CLI and full worker create a real Git worktree and persist a pending transition while the source turn is open",
    );

    proof.phase = "native-continuation";
    initial.release();
    await eventually(
      () => continuationReply.request,
      (request) => assert.equal(request?.completed, true),
      60_000,
    );

    // The archive can only finish after the destination model has responded.
    // Give durable publication its own deadline, including on an emulated guest.
    proof.phase = "canonical-history";
    const answers = (entries, text) =>
      entries.filter((message) =>
        message.content.some(
          (item) => item.type === "text" && item.text === text,
        ),
      );
    await eventually(
      messages,
      (entries) => {
        for (const [text, expectedLane] of [
          [initialText, source],
          [continuationText, pending],
        ]) {
          const answer = answers(entries, text);
          assert.equal(answer.length, 1);
          assert.equal(answer[0].executionLaneId, expectedLane.id);
          assert.equal(answer[0].worktreeId, expectedLane.worktreeId);
          assert.equal(
            answer[0].content.find((item) => item.text === text).correlation
              .sourceMethod,
            "native-history",
          );
        }
        const continuation = entries.filter(
          (message) =>
            message.role === "system" &&
            message.executionLaneId === pending.id &&
            message.content.some(
              (item) =>
                item.type === "text" &&
                item.text.startsWith("Continued in ") &&
                item.text.endsWith(
                  "Continue the user's request from this checkout.",
                ),
            ),
        );
        assert.equal(continuation.length, 1);
        assert.equal(continuation[0].worktreeId, worktree.id);
      },
      60_000,
    );
    const moved = await eventually(getChat, (current) => {
      assert.equal(current?.status, "idle");
      assert.equal(current.activeWorktreeId, worktree.id);
    });
    const settledLanes = await lanes();
    const destination = settledLanes.find(({ id }) => id === pending.id);
    assert.equal(destination.transitionKind, null);
    assert.ok(destination.codexThreadId);
    assert.notEqual(destination.codexThreadId, source.codexThreadId);
    assert.equal(
      settledLanes.find(({ id }) => id === source.id).state,
      "suspended",
    );
    const posts = model.requests.filter(({ method }) => method === "POST");
    assert.equal(posts.length, 2);
    assert.ok(posts.every(({ completed }) => completed));
    assert.ok(
      JSON.stringify(posts[1].input).includes(
        "Continue the user's request from this checkout.",
      ),
    );
    // Inspect the decoded model content so JSON escaping of Windows paths
    // cannot hide the exact working directory sent by the native runtime.
    const xmlCheckout = checkout.replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[character],
    );
    const providerWorkingDirectories = posts[1].input.input
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .filter(
        ({ type, text }) => type === "input_text" && typeof text === "string",
      )
      .flatMap(({ text }) => [
        ...text.matchAll(
          /<environment_context>([\s\S]*?)<\/environment_context>/g,
        ),
      ])
      .flatMap(([, context]) =>
        [...context.matchAll(/<cwd>([^<]*)<\/cwd>/g)].map(([, cwd]) => cwd),
      );
    assert.ok(
      providerWorkingDirectories.includes(xmlCheckout),
      "The native continuation must send the exact new checkout as its working directory",
    );
    assert.deepEqual(model.failures, []);
    result.steps.push(
      "the original turn settles and the native continuation runs in the new checkout with an attributed encrypted transcript",
    );

    proof.phase = "reopen";
    await stopWorker();
    const committed = await messages();
    const port = Number(new URL(fixture.server.origin).port);
    await fixture.close();
    await fixture.start({ port });
    assert.deepEqual(await messages(), committed);
    assert.deepEqual(await lanes(), settledLanes);
    assert.equal((await getChat()).activeWorktreeId, moved.activeWorktreeId);
    await startWorker();
    assert.deepEqual(await messages(), committed);
    assert.equal(await git("branch", "--show-current"), branch);
    assert.equal(
      model.requests.filter(({ method }) => method === "POST").length,
      2,
    );
    Object.assign(proof, {
      phase: "completed",
      destination,
      checkout,
      modelPosts: posts.length,
      transcriptMessages: committed.length,
      sourceAnswerOccurrences: answers(committed, initialText).length,
      destinationAnswerOccurrences: answers(committed, continuationText).length,
    });
    result.steps.push(
      "server and worker reopen the same checkout, lane and transcript without another native turn",
    );
  } finally {
    initial.release();
  }
}

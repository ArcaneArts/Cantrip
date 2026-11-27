import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { installClaudeCodeFixture } from "./actual-claude-label.mjs";
import { eventually } from "./full-worker.mjs";

function fixtureProgram() {
  const fs = require("node:fs");
  const path = require("node:path");
  if (process.argv[2] === "--version") {
    console.log("2.1.1 (Claude Code)");
    return;
  }
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const marker = "CANTRIP_ACTUAL_CLAUDE_TOOL_RESULT";
  const latestUser = input.conversation.findLast(({ role }) => role === "user");
  const text = JSON.stringify(latestUser?.content);
  const output = input.conversation
    .filter(({ type }) => type === "function_call_output")
    .find(({ output }) => JSON.stringify(output).includes(marker));
  const compact = text?.includes("CONTEXT CHECKPOINT COMPACTION");
  let decision;
  if (compact) {
    decision = {
      type: "message",
      text: "Fixture Claude summary retained the IDE result.",
    };
  } else if (text?.includes("Claude IDE tool fixture")) {
    if (output) {
      decision = {
        type: "message",
        text: "IDE received the actual Claude fixture tool result.",
      };
    } else {
      const tool = input.tools.find(
        ({ name }) => name === "exec_command" || name.endsWith(".exec_command"),
      );
      if (!tool) throw new Error("Codex did not offer its execution tool.");
      decision = {
        type: "function",
        name: tool.name,
        arguments: JSON.stringify({
          cmd: "printf 'CANTRIP_ACTUAL_CLAUDE_TOOL_RESULT\\n'",
          login: false,
          sandbox_permissions: "require_escalated",
          justification: "Run the disposable Claude tool fixture.",
        }),
      };
    }
  } else if (text?.includes("Claude Council fixture")) {
    decision = {
      type: "message",
      text: "Council received the Claude fixture response.",
    };
  } else if (text?.includes("Claude compact continuation fixture")) {
    const remembered = JSON.stringify(input.conversation).includes(
      "Fixture Claude summary retained the IDE result.",
    );
    if (!remembered)
      throw new Error("Codex did not carry forward the Claude summary.");
    decision = {
      type: "message",
      text: "IDE continued with the Claude fixture summary.",
    };
  } else {
    decision = {
      type: "message",
      text: "Chats received the Claude fixture response.",
    };
  }
  fs.appendFileSync(
    path.join(process.env.HOME, "fixture-responses.jsonl"),
    JSON.stringify({ decision, compact, returnedToolResult: Boolean(output) }) +
      "\n",
  );
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      structured_output: decision,
      usage: { input_tokens: 32, output_tokens: 8 },
    }),
  );
}

export async function actualClaudeResponses({
  page,
  projectId,
  workerId,
  workerDirectory,
  result,
  diagnostics,
}) {
  const profiles = await installClaudeCodeFixture(
    workerDirectory,
    `#!${process.execPath}\n(${fixtureProgram.toString()})();\n`,
  );
  const configuration = await page.evaluate(async (workerId) => {
    const models = await import("/src/lib/api/models.ts");
    const settings = await import("/src/lib/api/settings.ts");
    const { getWorkers } = await import("/src/lib/api/worker-wire.ts");
    const { ensureChatWorkerEncryption } =
      await import("/src/lib/chat-worker-encryption.ts");
    const provider = await models.createModelProvider({
      name: "Claude Code",
      kind: "claude-code",
      baseUrl: "https://claude-code.invalid",
    });
    const account = await models.createModelProviderAccount(provider.id, {
      label: "Primary Claude fixture",
      boundWorkerId: workerId,
    });
    const secondary = await models.createModelProviderAccount(provider.id, {
      label: "Separate Claude fixture",
      boundWorkerId: workerId,
    });
    const profile = await models.createModelProfile({
      name: "Claude Sonnet fixture",
      routes: [{ providerId: provider.id, modelName: "sonnet", enabled: true }],
    });
    await settings.updateSettings({
      defaultModelId: profile.id,
      defaultChatModelId: profile.id,
      defaultCouncilModelId: profile.id,
      autoNameChats: false,
    });
    const worker = (await getWorkers()).find(
      (worker) => worker.workerId === workerId,
    );
    await ensureChatWorkerEncryption({ worker });
    return {
      modelId: profile.id,
      reasoningEffort: null,
      customSubagentModel: false,
      subagentModelId: null,
      subagentReasoningEffort: null,
      fixtureProviderId: provider.id,
      accounts: [account.id, secondary.id],
    };
  }, workerId);
  const { fixtureProviderId, accounts, ...modelConfig } = configuration;
  const api = (operation, ...args) =>
    page.evaluate(
      async ({ operation, args }) =>
        (await import("/src/lib/api/chats.ts"))[operation](...args),
      { operation, args },
    );

  const trace = async () => {
    let directories;
    try {
      directories = await readdir(profiles);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return (
      await Promise.all(
        directories.map(async (id) => {
          try {
            const log = await readFile(
              path.join(profiles, id, "fixture-responses.jsonl"),
              "utf8",
            );
            return log
              .trim()
              .split("\n")
              .map((line) => ({ ...JSON.parse(line), profile: id }));
          } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
          }
        }),
      )
    ).flat();
  };
  const waitText = (chatId, text) =>
    eventually(
      () => api("getMessages", chatId),
      (messages) =>
        assert.ok(
          messages.some(({ content }) =>
            content.some((item) => item.text === text),
          ),
          diagnostics(),
        ),
      60_000,
    );
  const submit = (chatId, prompt) =>
    api("startTurn", chatId, prompt, modelConfig);
  const retain = (chatId) =>
    page.evaluate(
      (id) => window.folderLive.retainScope({ kind: "chat", chatId: id }),
      chatId,
    );
  const project = await api("createChat", projectId, "Claude IDE fixture");
  await retain(project.id);
  const pendingToolTurn = await submit(project.id, "Claude IDE tool fixture");
  assert.ok(["queued", "started"].includes(pendingToolTurn.status));
  const approval = await eventually(
    () =>
      api("getAgentInteractionRequests", {
        chatId: project.id,
        status: "pending",
      }),
    (requests) =>
      assert.ok(
        requests.some((request) => request.payload.kind === "commandExecution"),
        diagnostics(),
      ),
    60_000,
  );
  const requestId = approval.find(
    (request) => request.payload.kind === "commandExecution",
  ).id;
  await page.evaluate(async (id) => {
    const chats = await import("/src/lib/api/chats.ts");
    await chats.respondToAgentInteractionRequest(id, {
      idempotencyKey: crypto.randomUUID(),
      response: {
        kind: "commandExecution",
        decision: "accept",
        execpolicyAmendment: null,
        networkPolicyAmendment: null,
      },
    });
  }, requestId);
  await waitText(
    project.id,
    "IDE received the actual Claude fixture tool result.",
  );
  const preceding = await trace();
  const tool = preceding.find(({ decision }) => decision.type === "function");
  const returned = preceding.find(
    ({ returnedToolResult }) => returnedToolResult,
  );
  assert.ok(tool);
  assert.equal(returned?.profile, tool.profile);

  await eventually(
    () => api("getChats", projectId),
    (rows) =>
      assert.equal(rows.find((row) => row.id === project.id)?.status, "idle"),
  );
  assert.deepEqual(await api("compactChat", project.id), { accepted: true });
  await eventually(
    trace,
    (entries) =>
      assert.ok(
        entries.some(({ compact }) => compact),
        diagnostics(),
      ),
    60_000,
  );
  await eventually(
    () => api("getChats", projectId),
    (rows) =>
      assert.equal(rows.find((row) => row.id === project.id)?.status, "idle"),
  );
  await submit(project.id, "Claude compact continuation fixture");
  await waitText(project.id, "IDE continued with the Claude fixture summary.");

  await page.evaluate(
    async ({ id, accounts }) => {
      const { reorderModelProviderAccounts } =
        await import("/src/lib/api/models.ts");
      await reorderModelProviderAccounts(id, accounts.toReversed());
    },
    { id: fixtureProviderId, accounts },
  );
  const chat = await api("createStandaloneChat", "Claude Chats fixture");
  await retain(chat.id);
  await eventually(
    () => api("getStandaloneChats"),
    (rows) =>
      assert.ok(rows.find((row) => row.id === chat.id)?.activeScratchRootId),
  );
  await submit(chat.id, "Claude Chats fixture");
  await waitText(chat.id, "Chats received the Claude fixture response.");

  const council = await page.evaluate(async () => {
    const { createCouncilAgent } = await import("/src/lib/api/council.ts");
    return createCouncilAgent(
      "Claude Council fixture",
      "Give short status answers.",
    );
  });
  await retain(council.id);
  await eventually(
    () =>
      page.evaluate(async (id) => {
        const { listCouncilAgents } = await import("/src/lib/api/council.ts");
        return (await listCouncilAgents()).find((agent) => agent.id === id);
      }, council.id),
    (current) => assert.equal(current?.scratchStatus, "ready"),
  );
  await submit(council.id, "Claude Council fixture");
  await waitText(council.id, "Council received the Claude fixture response.");
  const entries = await trace();
  const chatProfile = entries.find(
    ({ decision }) =>
      decision.text === "Chats received the Claude fixture response.",
  )?.profile;
  assert.ok(chatProfile && chatProfile !== tool.profile);
  result.claudeResponses = {
    ideToolApproved: true,
    toolResultReturned: true,
    summaryContinued: true,
    chats: true,
    council: true,
    workerProfiles: new Set(entries.map(({ profile }) => profile)).size,
  };
  result.steps.push(
    "Bundled Codex executed an approved Claude tool call and returned its result, then completed IDE compaction, Chats, and Council with the fixture CLI.",
  );
}

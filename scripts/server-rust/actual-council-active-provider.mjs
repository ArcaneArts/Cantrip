import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { codexAccountHome } from "../../tests/reference-node-worker/src/codex/account-home.ts";
import { projectToolOutput } from "./actual-council-project-creation.mjs";
import { eventually } from "./full-worker.mjs";
import { modelFunctions } from "./task-model-provider.mjs";

const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const postgres = require("postgres");

export const councilQuotaAccounts = [
  "disposable-council-source",
  "disposable-council-target",
];

export async function prepareActiveCouncilAccounts({
  page,
  workerId,
  workerDirectory,
  providerId,
  accounts,
  model,
}) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = (claims) =>
    `${encode({ alg: "none" })}.${encode(claims)}.local-fixture`;
  for (const [index, id] of accounts.entries()) {
    const account = councilQuotaAccounts[index];
    const directory = codexAccountHome(workerDirectory, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(directory, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          account_id: account,
          access_token: jwt({
            exp: Math.floor(Date.now() / 1000) + 86400,
            sub: account,
          }),
          refresh_token: "local-fixture-token",
          id_token: jwt({
            email: `${account}@example.invalid`,
            "https://api.openai.com/auth": {
              chatgpt_account_id: account,
              chatgpt_plan_type: "pro",
              chatgpt_user_id: account,
            },
          }),
        },
      }),
      { mode: 0o600 },
    );
    const status = await page.evaluate(
      async ({ providerId, id, workerId }) =>
        (await import("/src/lib/api/models.ts")).getCodexAuthStatus(
          providerId,
          id,
          workerId,
        ),
      { providerId, id, workerId },
    );
    assert.equal(
      status.authenticated,
      true,
      status.loginError ?? "Disposable account imported",
    );
  }
  await eventually(
    async () => {
      const result = await page.evaluate(
        async ({ providerId, accounts, workerId }) => {
          const { getProviderRateLimitResets } =
            await import("/src/lib/api/models.ts");
          return Promise.all(
            accounts.map((accountId) =>
              getProviderRateLimitResets(providerId, accountId, workerId).then(
                () => null,
                (error) => error.message,
              ),
            ),
          );
        },
        { providerId, accounts, workerId },
      );
      if (result.some(Boolean)) await delay(250);
      return result;
    },
    (errors) => assert.deepEqual(errors, [null, null]),
    30_000,
  );
  assert.deepEqual(model.accountQuotaReads, new Set(councilQuotaAccounts));
}

export async function actualCouncilActiveProvider({
  page,
  appOrigin,
  databaseUrl,
  chatId,
  model,
  submit,
  readChat,
  readMessages,
  restartWorker,
  result,
  sourceRoute,
  sourceAccount,
  targetAccount,
}) {
  const original = "Find the original release result and finish the briefing.";
  const progress = "The release result was confirmed as Q-295.";
  const finished = "The Council briefing is complete after native resume.";
  const calls = [];
  const boundaryCalls = [];
  const discover = model.reply({
    responseId: "active-quota-tools",
    toolSearch: {
      query: "council_message_post council_memory_read",
      limit: 20,
    },
  });
  const first = model.reply({
    responseId: "active-quota-progress",
    calls,
    headers: {
      "x-codex-primary-used-percent": "97",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 3600),
    },
    hold: true,
  });
  const near = model.reply({
    responseId: "active-quota-signal",
    calls: boundaryCalls,
    hold: true,
  });
  const destination = model.reply({
    responseId: "active-quota-resumed",
    text: finished,
  });
  const observation = (result.activeCouncilProvider = {
    chatId,
    sourceRoute,
    sourceAccount,
    targetAccount,
  });
  const sql = postgres(databaseUrl, { max: 1 });
  const state = async () => {
    const [row] = await sql`SELECT jsonb_build_object(
            'phase',s.phase,'sourceOperation',s.source_operation_id,
            'thread',s.source_thread_id,'turn',s.source_turn_id,'oldRuntime',s.source_runtime_generation,
            'resumeOperation',r.operation_id,'newRuntime',r.identity->>'runtimeGeneration',
            'resumeRoute',r.identity->>'modelRouteId','resumeTurn',r.intent->'restoredSuspension'->'checkpoint'->>'turnId',
            'sourceAccount',n.identity->>'providerAccountId','resumeAccount',r.identity->>'providerAccountId',
            'sameRun',r.logical_operation_id=n.logical_operation_id,
            'current',c.native_suspension_state->>'phase'
         ) AS state FROM council_live_provider_switches s
         JOIN native_commands n ON n.operation_id=s.source_operation_id
         JOIN chats c ON c.id=s.chat_id
         LEFT JOIN LATERAL (
           SELECT operation_id,identity,intent,logical_operation_id FROM native_commands
           WHERE previous_operation_id=n.operation_id AND method='thread/resume'
           ORDER BY created_at DESC LIMIT 1
         ) r ON true
         WHERE s.chat_id=${chatId}`;
    const stored = row?.state;
    observation.ledger = stored ?? null;
    return stored;
  };
  try {
    assert.equal((await submit(original)).status, "queued");
    await eventually(
      () => first.request,
      (request) => assert.ok(request),
      60_000,
    );
    assert.equal(discover.request.account, councilQuotaAccounts[0]);
    const definitions = first.request.input.input.find(
      ({ type, call_id }) =>
        type === "tool_search_output" &&
        call_id === "active-quota-tools-search",
    )?.tools;
    const tools = modelFunctions(definitions);
    const tool = tools.find(
      ({ name }) =>
        name === "council_message_post" ||
        name.endsWith("__council_message_post"),
    );
    assert.ok(tool, "Quiet progress is available from native tool search");
    const readMemory = tools.find(
      ({ name }) =>
        name === "council_memory_read" ||
        name.endsWith("__council_memory_read"),
    );
    assert.ok(readMemory);
    calls.push({
      ...tool,
      arguments: {
        operationId: randomUUID(),
        text: progress,
        kind: "progress",
        notify: false,
      },
    });
    boundaryCalls.push({ ...readMemory, arguments: {} });
    first.release();
    await eventually(
      () => near.request,
      (request) => assert.ok(request),
      60_000,
    );
    const posted = projectToolOutput(near, "active-quota-progress-call-0");
    assert.ok(posted.messageId);
    await eventually(
      state,
      (value) => {
        assert.ok(value, "Core recorded an actual quota update");
        assert.equal(value.current, "pausing");
      },
      60_000,
    );
    near.release();
    await eventually(
      state,
      (value) => {
        assert.equal(value.phase, "completed");
        assert.equal(value.resumeTurn, value.turn);
        assert.equal(value.sameRun, true);
        assert.notEqual(value.oldRuntime, value.newRuntime);
        assert.equal(value.resumeRoute, sourceRoute);
        assert.equal(value.sourceAccount, sourceAccount);
        assert.equal(value.resumeAccount, targetAccount);
      },
      75_000,
    );
    assert.equal(near.request.completed, true);
    assert.ok(
      destination.entered,
      "The replacement native process sent model work",
    );
    observation.replacementModel = destination.request.input.model;
    assert.equal(first.request.account, councilQuotaAccounts[0]);
    assert.equal(near.request.account, councilQuotaAccounts[0]);
    assert.equal(destination.request.account, councilQuotaAccounts[1]);
    assert.equal(destination.request.input.model, first.request.input.model);
    const messages = await eventually(
      readMessages,
      (values) => {
        assert.ok(
          values.some(({ content }) =>
            content.some(({ text }) => text === finished),
          ),
        );
      },
      60_000,
    );
    const withText = (text) =>
      messages.filter(({ content }) =>
        content.some((item) => item.text === text),
      );
    assert.equal(withText(original).length, 1);
    assert.equal(withText(progress).length, 1);
    assert.equal(withText(progress)[0].id, posted.messageId);
    assert.equal(withText(finished).length, 1);
    assert.ok(
      !messages.some(({ content }) =>
        content.some((item) => item.councilProviderRecovery),
      ),
    );
    assert.equal((await readChat()).providerRecovery.phase, "continued");
    assert.deepEqual(model.failures, []);
    const url = new URL(appOrigin);
    url.searchParams.set("councilAgent", chatId);
    await page.goto(url.href);
    await page
      .getByText(
        "Switched from Council source account to Council alternate account.",
        { exact: true },
      )
      .waitFor();
    const followUp = "Give me the reference number from the briefing.";
    const replay = model.reply({
      text: "The reference number in the earlier work was Q-295.",
    });
    await restartWorker();
    assert.equal((await submit(followUp)).status, "queued");
    await eventually(
      () => replay.request?.completed,
      (complete) => assert.equal(complete, true),
      60_000,
    );
    assert.equal(replay.request.account, councilQuotaAccounts[1]);
    assert.ok(JSON.stringify(replay.request.input.input).includes("Q-295"));
    await eventually(readMessages, (messages) => {
      assert.ok(
        messages.some(({ content }) =>
          content.some(
            ({ text }) =>
              text === "The reference number in the earlier work was Q-295.",
          ),
        ),
      );
    });
    assert.deepEqual(model.failures, []);
    result.steps.push(
      "The replacement Codex process resumed the same native Council turn exactly once and retained conversation history after a cold Worker restart.",
    );
  } finally {
    observation.modelBoundaryFailures = model.failures;
    observation.modelRequests = model.requests.map(
      ({ method, path, account }) => ({ method, path, account }),
    );
    first.release();
    near.release();
    await sql.end({ timeout: 5 });
  }
}

// Real native presentation compared with the unchanged Node implementation.
// All content and keys are synthetic; the native child cannot find Node.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { renderNativeHistoryItem } from "../../tests/reference-node-worker/src/native-history-render.ts";
import {
  normalizeCodexThreadItem,
  latestChangedLine,
  changedLinesPreview,
} from "../../tests/reference-node-worker/src/codex/event-normalization.ts";
import {
  createAgentActivityRawEnvelope,
  redactAgentActivityText,
} from "../../tests/reference-node-worker/src/codex/raw-capture.ts";
import {
  appendBoundedCommandOutput,
  boundedCommandOutput,
  transcriptCommandOutput,
} from "../../tests/reference-node-worker/src/codex/command-output.ts";
import {
  protectChatMessage,
  openMessage,
} from "../../tests/reference-node-worker/src/chat-message-encryption.ts";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary);
const child = spawn(values.binary, [], {
  env: { ...process.env, PATH: "/usr/bin:/bin" },
  stdio: ["pipe", "pipe", "inherit"],
});
const completed = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
async function* lines(stream) {
  stream.setEncoding("utf8");
  let partial = "";
  for await (const chunk of stream) {
    partial += chunk;
    let end;
    while ((end = partial.indexOf("\n")) >= 0) {
      yield partial.slice(0, end);
      partial = partial.slice(end + 1);
    }
  }
  assert.equal(partial, "");
}
const output = lines(child.stdout);
let comparisons = 0;
async function native(input) {
  child.stdin.write(JSON.stringify(input) + "\n");
  const line = await output.next();
  assert.equal(line.done, false);
  return JSON.parse(line.value);
}
async function compare(input, expected, label = input.op) {
  const actual = await native(input);
  assert.equal(actual.ok, true, `${label}: ${actual.error}`);
  assert.deepEqual(actual.value, expected, label);
  comparisons++;
  return actual.value;
}
const context = {
  threadId: "thread",
  turnId: "turn",
  cwd: process.platform === "win32" ? "C:\\project" : "/project",
  mode: "default",
};
const source = (body, lifecycle = "completed") => ({
  id: "native",
  identityKind: "canonical",
  revision: 1,
  ordinal: 0,
  body: { id: "native", ...body },
  lifecycle,
  completeBody: true,
  startedAtMs: null,
  completedAtMs: null,
  conflicts: [],
  origin: { generation: "runtime", sequence: 1, kind: "notification" },
});
const scope = {
  agentThreadId: "thread",
  rootThreadId: "root",
  parentThreadId: "root",
  rootTurnId: "root-turn",
  agentPath: ["root", "child"],
  nickname: null,
  role: null,
  depth: 1,
  isRoot: false,
};
const correlation = {
  sourceMethod: "item/completed",
  diagnosticId: null,
  threadId: "thread",
  turnId: "turn",
  itemId: "native",
};
const command = {
  type: "commandExecution",
  command: "printf fixture",
  cwd: context.cwd,
  aggregatedOutput: "\x1b[31mred\x1b[0m\nfull",
  status: "completed",
  exitCode: 0,
  durationMs: 10,
};
const mcp = {
  type: "mcpToolCall",
  server: "codegraph",
  tool: "explore",
  arguments: { query: "where?", api_key: "sk-private12345" },
  result: { content: [{ type: "text", text: "safe result" }] },
  error: null,
  status: "completed",
  durationMs: null,
};
const bodies = [
  {
    type: "userMessage",
    content: [
      { type: "text", text: "  exact\ntext  " },
      { type: "image", url: "private-image" },
    ],
  },
  { type: "userMessage", content: [] },
  { type: "userMessage", content: null },
  {
    type: "agentMessage",
    text: " exact\u2028\ud800text\n ",
    phase: "final_answer",
  },
  { type: "agentMessage", text: "", phase: "commentary" },
  { type: "agentMessage", text: 42 },
  { type: "reasoning", summary: [" before ", "", "after\udfff"] },
  {
    type: "reasoning",
    summaryParts: {
      0: "first",
      2: "third",
      10000000000: "sparse",
      bad: "excluded",
      "01": "excluded",
    },
  },
  {
    type: "reasoning",
    summary: Array.from({ length: 104 }, (_, i) => `part ${i}`),
  },
  command,
  { ...command, aggregatedOutput: "output\n".repeat(50000) },
  { type: "plan", text: " exact plan\n".repeat(4000) },
  ...["add", "delete", "update"].map((kind) => ({
    type: "fileChange",
    status: "completed",
    changes: [
      {
        path: context.cwd + "/notes/file",
        kind: { type: kind },
        diff:
          kind === "update"
            ? "--- a\n+++ b\n-old\n+new\r\n"
            : " first\r\n\r\nlast\r",
      },
    ],
  })),
  mcp,
  {
    type: "dynamicToolCall",
    namespace: "  namespace  ",
    tool: "tool",
    success: true,
    status: "completed",
    durationMs: 1,
  },
  {
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    senderThreadId: "thread",
    receiverThreadIds: ["child"],
    prompt: " child prompt ",
    model: null,
    agentsStates: { child: { status: "completed", message: "done" } },
    status: "completed",
  },
  {
    type: "subAgentActivity",
    kind: "interrupted",
    agentThreadId: "child",
    agentPath: "",
  },
  ...[
    null,
    { type: "search", queries: ["one", "two"] },
    {
      type: "open_page",
      url: "https://user:password@example.test/path?secret=private#private",
    },
    {
      type: "find_in_page",
      url: "invalid path?private#private",
      pattern: "needle",
    },
    { type: "open_page", url: "data:text/plain,has ?query#fragment" },
  ].map((action) => ({ type: "webSearch", query: "fixture", action })),
  { type: "imageView", path: context.cwd + "/../other/image.png" },
  { type: "enteredReviewMode", review: "review" },
  { type: "exitedReviewMode", review: "review" },
  { type: "contextCompaction" },
  {
    type: "interAgentCommunication",
    author: "/root",
    recipient: "/root/child",
    otherRecipients: [],
    triggerTurn: true,
    text: "child instruction",
    encryptedContent: null,
  },
  {
    type: "interAgentCommunication",
    author: "/root",
    recipient: "/root/child",
    otherRecipients: ["/root/checker"],
    triggerTurn: false,
    text: "must not display",
    encryptedContent: "private",
  },
  {
    type: "hookPrompt",
    fragments: [
      { text: "first\n", hookRunId: "run" },
      { text: "second", hookRunId: "other" },
    ],
  },
  { type: "hookPrompt", fragments: [] },
  { type: "hookPrompt", fragments: [null] },
  {
    type: "functionCallOutput",
    name: "tool",
    namespace: "ns",
    output: [
      { type: "input_text", text: "before" },
      { type: "input_image", image_url: "private" },
      { type: "encrypted_content", encrypted_content: "private" },
      { type: "input_text", text: "after" },
    ],
  },
  {
    type: "functionCallOutput",
    name: "tool",
    namespace: null,
    output: " exact output ",
  },
  { type: "sleep", durationMs: 150000 },
  { type: "sleep", durationMs: -1 },
  {
    type: "imageGeneration",
    status: "failed",
    result: "",
    failure: { type: "usageLimitExceeded" },
  },
  {
    type: "imageGeneration",
    status: "completed",
    result: "private-image",
    revisedPrompt: "",
    transparentBackground: true,
    savedPath: "/retained/path",
  },
  { type: "futureItem", secret: "retained source" },
  { type: "fileChange", changes: null },
];
try {
  for (const body of bodies) {
    for (const lifecycle of ["started", "completed", "unknown"]) {
      const item = source(body, lifecycle);
      await compare(
        { op: "presentation.render", item, context },
        renderNativeHistoryItem(item, context),
        `${body.type}/${lifecycle}`,
      );
    }
  }
  for (const body of bodies.filter((b) =>
    [
      "userMessage",
      "agentMessage",
      "functionCallOutput",
      "imageGeneration",
    ].includes(b.type),
  )) {
    const item = source(body);
    const selected = {
      ...context,
      agentScope: scope,
      inputParts: {
        0: [{ type: "text", text: "authorized image reference" }],
        1: [{ type: "text", text: "authorized second reference" }],
      },
    };
    await compare(
      { op: "presentation.render", item, context: selected },
      renderNativeHistoryItem(item, {
        ...selected,
        inputParts: new Map(
          Object.entries(selected.inputParts).map(([k, v]) => [Number(k), v]),
        ),
      }),
      `${body.type}/authorized-child`,
    );
  }
  const conflict = source({ type: "agentMessage", text: "chosen" });
  conflict.conflicts.push({
    body: { type: "agentMessage", text: "other" },
    lifecycle: "completed",
    completeBody: true,
    startedAtMs: null,
    completedAtMs: null,
    origin: { generation: "other", sequence: 1, kind: "snapshot" },
  });
  await compare(
    { op: "presentation.render", item: conflict, context },
    renderNativeHistoryItem(conflict, context),
    "conflict retention",
  );
  const mismatch = await native({
    op: "presentation.render",
    item: conflict,
    context: { ...context, agentScope: { ...scope, agentThreadId: "other" } },
  });
  assert.equal(mismatch.ok, false);
  assert.equal(
    mismatch.error,
    "Native history render scope belongs to another thread.",
  );
  comparisons++;
  const errors = [
    { content: [{ type: "text", text: "MCP error -32602: invalid argument" }] },
    {
      structuredContent: {
        error: {
          code: "stale-binding",
          message: "Refresh binding.",
          retryable: false,
        },
      },
    },
    {
      content: [
        {
          text: JSON.stringify({
            error: null,
            result: { content: [{ text: "binding mismatch" }] },
            status: "failed",
          }),
        },
      ],
    },
    { content: [{ text: "token=private-value " + "x".repeat(8000) }] },
    {
      error: {
        code: "empty-message",
        message: "   ",
        cause: { message: "HTTP 503: retry", retryable: true },
      },
    },
  ];
  const normalized = [
    ...bodies.filter(
      (b) =>
        ![
          "userMessage",
          "agentMessage",
          "hookPrompt",
          "functionCallOutput",
          "sleep",
          "imageGeneration",
          "fileChange",
          "futureItem",
        ].includes(b.type),
    ),
    ...errors.map((result) => ({
      ...mcp,
      status: "failed",
      result,
      error: { message: "MCP tool call failed." },
    })),
    {
      ...command,
      status: "failed",
      aggregatedOutput: "x\ud800\x1b]0;private title\x07retained",
    },
  ];
  for (const body of normalized) {
    const item = { id: "native", ...body };
    for (const telemetry of [
      {},
      {
        captureRaw: true,
        startedAtMs: 100,
        updatedAtMs: 250,
        completedAtMs: 300,
      },
    ]) {
      const input = {
        op: "presentation.normalize",
        item,
        cwd: context.cwd,
        lifecycle: "completed",
        correlation,
        telemetry,
      };
      let expected;
      try {
        expected = normalizeCodexThreadItem(
          item,
          context.cwd,
          "completed",
          correlation,
          telemetry,
        );
      } catch {
        const actual = await native(input);
        assert.equal(actual.ok, false, `${body.type}/malformed`);
        comparisons++;
        continue;
      }
      await compare(
        input,
        expected,
        `${body.type}/normalize/${!!telemetry.captureRaw}`,
      );
    }
  }
  const telemetries = [
    { commandOutput: { output: "explicit tail" } },
    {
      captureRaw: true,
      commandOutput: { output: "retained tail", truncated: true },
      status: "declined",
      updatedAtMs: 250,
    },
    {
      captureRaw: true,
      commandOutput: { output: null, truncated: false },
      startedAtMs: 100,
      completedAtMs: null,
    },
  ];
  for (const telemetry of telemetries) {
    const item = { id: "native", ...command };
    await compare(
      {
        op: "presentation.normalize",
        item,
        cwd: context.cwd,
        lifecycle: "started",
        correlation,
        telemetry,
      },
      // Optional explicit undefined fields disappear at the same JSON boundary
      // crossed by the native fixture, rather than becoming null.
      JSON.parse(
        JSON.stringify(
          normalizeCodexThreadItem(
            item,
            context.cwd,
            "started",
            correlation,
            telemetry,
          ),
        ),
      ),
      "independent command telemetry",
    );
  }
  for (const output of [
    null,
    "",
    "plain\ud800 retained\u2028",
    "\x1b]8;;https://private.test\x1b\\link\x1b]8;;\x1b\\\x1b[31mred\x1b[0m\x00\x7f\x85\n",
    "界😀".repeat(70000),
  ]) {
    await compare(
      { op: "presentation.command.bound", output },
      boundedCommandOutput(output),
    );
    await compare(
      { op: "presentation.command.transcript", output },
      transcriptCommandOutput(output),
    );
  }
  for (const current of [
    { output: null, truncated: false },
    { output: "retained", truncated: true },
    { output: "界".repeat(85000), truncated: false },
  ]) {
    const delta = "😀".repeat(3000) + "\x1b[2K\nlast";
    await compare(
      { op: "presentation.command.append", current, delta },
      appendBoundedCommandOutput(current, delta),
    );
  }
  for (const diff of [
    "",
    "@@ -1 +1 @@\n-old\n+new\r\n",
    "--- header\n+++ header\n-removed",
    "+" + "😀".repeat(5000),
  ]) {
    await compare(
      { op: "presentation.diff", diff },
      {
        latestLine: latestChangedLine(diff),
        diffPreview: changedLinesPreview(diff),
      },
    );
  }
  let deep = { value: "retained" };
  for (let i = 0; i < 23; i++) deep = { nested: deep };
  const captures = [
    {
      request: {
        Authorization: "Bearer private",
        nested: { api_key: "sk-private1234", query: "safe" },
      },
      response: "token=private safe",
      metadata: { cookie: "private", requestId: "fixture" },
    },
    {
      response: {
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: "PRIVATE".repeat(50000),
          },
          { type: "text", text: "useful" },
        ],
        structuredContent: {
          image: { type: "image", mimeType: "bad", data: null },
        },
      },
    },
    { request: "a".repeat(65535) + "😀", response: "a".repeat(262143) + "界" },
    { request: "\ufeff" + "界".repeat(22000) },
    {
      request: "\ud800\ufeff\u2028",
      response: deep,
      metadata: Object.fromEntries(
        Array.from({ length: 35 }, (_, i) => [String(i), i]),
      ),
    },
  ];
  for (const input of captures) {
    await compare(
      { op: "presentation.capture", ...input },
      createAgentActivityRawEnvelope(input),
    );
  }
  await compare(
    {
      op: "presentation.capture",
      requestBytes: [],
      responseBytes: [1, 2, 3, 255],
      metadata: { source: "binary" },
    },
    createAgentActivityRawEnvelope({
      request: new Uint8Array(),
      response: new Uint8Array([1, 2, 3, 255]),
      metadata: { source: "binary" },
    }),
  );
  const privateText =
    "Bearer abcdef api_key = private-token pk-providerSecret123\ud800";
  await compare(
    { op: "presentation.redact", text: privateText },
    redactAgentActivityText(privateText),
  );
  // Real message codec consumes a native-rendered draft in both directions.
  const key = new Uint8Array(32).fill(1),
    id = "10ee8f74-b25d-41fd-bad3-e9355c6d934e";
  const service = {
    ownerId: () => "owner",
    componentKey: () => ({ key: key.slice(), keyRevision: 1 }),
  };
  const item = source(
    {
      type: "agentMessage",
      text: " native rendered encrypted output\n",
      phase: "final_answer",
    },
    "started",
  );
  const rendered = await compare(
    { op: "presentation.render", item, context },
    renderNativeHistoryItem(item, context),
  );
  const wire = await native({
    op: "content.message.protect",
    id,
    message: { ...rendered[0].message, idempotencyKey: "fixture" },
  });
  assert.equal(wire.ok, true, wire.error);
  assert.deepEqual(
    await openMessage({
      message: wire.value,
      componentKey: key,
      ownerId: "owner",
    }),
    rendered[0].message.content,
  );
  comparisons++;
  const protectedMessage = await protectChatMessage({
    service,
    id,
    message: { ...rendered[0].message, idempotencyKey: "fixture" },
  });
  const opened = await native({
    op: "content.message.open",
    message: protectedMessage,
  });
  assert.equal(opened.ok, true, opened.error);
  assert.deepEqual(opened.value, rendered[0].message.content);
  comparisons++;
  console.log(
    JSON.stringify({
      nativePresentationComparisons: comparisons,
      nodeRuntimeInNativeChild: false,
    }),
  );
} finally {
  child.stdin.end();
  assert.equal(await completed, 0);
}

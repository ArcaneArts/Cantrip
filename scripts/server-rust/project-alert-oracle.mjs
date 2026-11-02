import * as p from "../../packages/protocol/dist/index.js";
const event = {
  projectId: "project",
  chatId: "chat",
  source: "interaction",
  sourceId: "request",
  episodeId: "request",
  sourceRevision: 1,
  kind: "permission",
  status: "open",
  target: { kind: "interaction", chatId: "chat", requestId: "request" },
  occurredAt: "2026-11-02T12:00:00.000Z",
};
const detail = {
  context: {
    domain: "alert-content",
    serverId: "server",
    workerId: "worker",
    scopeId: "chat",
    operationId: "11111111-1111-4111-8111-111111111111",
    operation: "alert.raise",
    direction: "stored",
    sequence: 1,
  },
  protectedContent: {
    formatVersion: 1,
    domain: "alert-content",
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    },
  },
};
const agent = {
  ...event,
  source: "agent",
  kind: "blocked",
  target: { kind: "chat", chatId: "chat", turnId: null },
  protectedDetail: detail,
};
const inputs = [
  event,
  { ...event, sourceRevision: 0 },
  { ...event, target: { ...event.target, chatId: "foreign" } },
  { ...event, sourceId: "wrong" },
  agent,
  { ...agent, kind: "permission" },
  { ...agent, protectedDetail: null },
  {
    ...agent,
    protectedDetail: {
      ...detail,
      context: { ...detail.context, scopeId: "foreign" },
    },
  },
  { ...event, protectedDetail: detail },
  { ...agent, target: { kind: "goal", chatId: "chat", threadId: null } },
  { ...event, plainText: "SECRET" },
];
const cases = inputs.map((input) => ["projectAlertProjectionSchema", input]);
for (const input of [
  {},
  { limit: "3" },
  { limit: 101 },
  { after: "bad" },
  { after: "alert_" + "a".repeat(64) },
  { limit: 1, extra: true },
])
  cases.push(["projectAlertQuerySchema", input]);
for (const input of [
  detail,
  { ...detail, context: { ...detail.context, direction: "event" } },
  {
    ...detail,
    protectedContent: { ...detail.protectedContent, domain: "run-content" },
  },
])
  cases.push(["projectAlertProtectedDetailSchema", input]);
const observation = {
  chatId: "chat",
  workerId: "worker",
  threadId: "thread",
  generation: "11111111-1111-4111-8111-111111111111",
  revision: 1,
  snapshot: { kind: "chat-encrypted", goal: null },
};
for (const input of [
  observation,
  { ...observation, generation: "2026-11-02T00:00:00.000Z" },
  { ...observation, revision: 0 },
  {
    ...observation,
    snapshot: { kind: "chat-encrypted", goal: { objective: "SECRET" } },
  },
])
  cases.push(["projectGoalObservationSchema", input]);
for (const input of [
  {
    key: observation.generation,
    revision: 1,
    title: "Blocked",
    message: "Need input",
    nextStep: "Answer",
  },
  {
    key: observation.generation,
    revision: 1,
    kind: "permission",
    title: "Forged",
    message: "Bad",
    nextStep: "Approve",
  },
])
  cases.push(["cantripMcpAlertRaiseInputSchema", input]);
process.stdout.write(
  JSON.stringify(
    cases.map(([schema, input]) => {
      const result = p[schema].safeParse(input);
      return {
        schema,
        input,
        success: result.success,
        ...(result.success ? { data: result.data } : {}),
      };
    }),
  ),
);

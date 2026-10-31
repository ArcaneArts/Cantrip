import assert from "node:assert/strict";
import * as p from "../../packages/protocol/dist/index.js";
import {
  interactionRequest as request,
  interactionResponse as response,
} from "./agent-interaction-fixtures.mjs";
import { literal, json } from "./project-target-state.mjs";
export async function runInteractionResponseCases(h) {
  const { record, call, ids, seed, pair } = h;
  const cases = [
    [
      "command",
      {
        kind: "commandExecution",
        startedAtMs: 1,
        approvalId: null,
        environmentId: null,
        reason: null,
        command: "echo fixture",
        cwd: "/fixture",
        networkApprovalContext: null,
        additionalPermissions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        availableDecisions: [
          "accept",
          "acceptWithExecpolicyAmendment",
          "applyNetworkPolicyAmendment",
        ],
      },
      [
        [
          "unavailable decision",
          { kind: "commandExecution", decision: "decline" },
          true,
        ],
        [
          "missing execpolicy amendment",
          {
            kind: "commandExecution",
            decision: "acceptWithExecpolicyAmendment",
          },
          true,
        ],
        [
          "missing network amendment",
          { kind: "commandExecution", decision: "applyNetworkPolicyAmendment" },
          true,
        ],
        [
          "execpolicy amendment",
          {
            kind: "commandExecution",
            decision: "acceptWithExecpolicyAmendment",
            execpolicyAmendment: ["fixture"],
          },
          false,
        ],
        [
          "network amendment",
          {
            kind: "commandExecution",
            decision: "applyNetworkPolicyAmendment",
            networkPolicyAmendment: {
              host: "fixture.invalid",
              action: "allow",
            },
          },
          false,
        ],
        [
          "accept command",
          { kind: "commandExecution", decision: "accept" },
          false,
        ],
      ],
    ],
    [
      "permissions",
      {
        kind: "permissions",
        startedAtMs: 1,
        environmentId: null,
        cwd: "/fixture",
        reason: null,
        requestedPermissions: {
          network: { enabled: true, domains: ["fixture.invalid"] },
          filesystem: { read: [{ path: "/one", access: "read" }], write: [] },
          flag: null,
        },
      },
      [
        ["empty grant", {}, false],
        [
          "recursive subset",
          { network: { domains: ["fixture.invalid"] } },
          false,
        ],
        [
          "same array object",
          { filesystem: { read: [{ path: "/one", access: "read" }] } },
          false,
        ],
        [
          "reordered array object",
          { filesystem: { read: [{ access: "read", path: "/one" }] } },
          true,
        ],
        [
          "wrong array element",
          { network: { domains: ["other.invalid"] } },
          true,
        ],
        ["extra grant", { other: true }, true],
        ["wrong primitive", { network: { enabled: false } }, true],
        ["null matches", { flag: null }, false],
        ["array cannot replace object", [], true],
        ["object cannot replace array", { filesystem: { read: {} } }, true],
      ].map(([name, permissions, error]) => [
        name,
        { kind: "permissions", permissions, scope: "turn" },
        error,
      ]),
    ],
    [
      "questions",
      {
        kind: "userInput",
        autoResolutionMs: null,
        questions: [
          {
            id: "secret",
            header: "Secret",
            question: "Secret?",
            isOther: false,
            isSecret: true,
            options: null,
          },
          {
            id: "public",
            header: "Public",
            question: "Public?",
            isOther: true,
            isSecret: false,
            options: [{ label: "yes", description: "" }],
          },
        ],
      },
      [
        [
          "missing answer",
          {
            kind: "userInput",
            answers: { secret: { answers: ["private-marker"] } },
          },
          true,
        ],
        [
          "extra answer",
          {
            kind: "userInput",
            answers: {
              secret: { answers: ["private-marker"] },
              public: { answers: ["yes"] },
              extra: { answers: ["no"] },
            },
          },
          true,
        ],
        [
          "secret answers redact",
          {
            kind: "userInput",
            answers: {
              secret: { answers: ["private-marker"] },
              public: { answers: ["yes"] },
            },
          },
          false,
        ],
      ],
    ],
    [
      "elicitation",
      {
        kind: "mcpElicitation",
        serverName: "fixture",
        mode: "form",
        message: "Fixture",
        requestedSchema: {},
        url: null,
        elicitationId: null,
        metadata: null,
      },
      [
        [
          "mcp accepted",
          {
            kind: "mcpElicitation",
            action: "accept",
            content: { choice: true },
          },
          false,
        ],
        [
          "mcp declined",
          { kind: "mcpElicitation", action: "decline", content: null },
          false,
        ],
      ],
    ],
  ];
  for (const [kind, payload, responses] of cases) {
    const rows = await record(
      "response checks " + kind,
      request("response-" + kind, { payload }),
    );
    for (const [name, value, error] of responses) {
      const input = p.agentInteractionResolutionCreateSchema.parse({
        idempotencyKey: name,
        response: value,
      });
      await call(name, "validate", (i) => ({ ...ids(rows)(i), input }), {
        error,
      });
    }
    const good = responses.findLast(([, , error]) => !error),
      input = p.agentInteractionResolutionCreateSchema.parse({
        idempotencyKey: "store-" + kind,
        response: good[1],
      });
    const saved = await call("store validated " + kind, "resolve", (i) => ({
      ...ids(rows)(i),
      input,
    }));
    if (kind === "questions")
      for (const row of saved) {
        assert.equal(JSON.stringify(row).includes("private-marker"), false);
        assert.deepEqual(row.response.answers.secret, {
          answers: ["[redacted]"],
        });
        assert.deepEqual(row.response.answers.public, { answers: ["yes"] });
      }
  }
  const expiry = await record(
    "explicit future expiry",
    request("explicit-expiry", { expiresAt: "2099-01-01T00:00:00.456Z" }),
  );
  await call("expiry before future request", "expire", {
    now: new Date().toISOString(),
  });
  const deadline = new Date().toISOString();
  await seed(
    `UPDATE agent_interaction_requests SET expires_at=${literal(deadline)} WHERE request_key='explicit-expiry'`,
  );
  const expired = await call("expiry equals deadline", "expire", {
    now: deadline,
  });
  for (const rows of expired)
    assert.ok(rows.some((r) => r.requestKey === "explicit-expiry"));
  // Read mapped schema failures after the actual committed expiry update.
  const invalid = await record(
    "invalid terminal row",
    request("invalid-terminal"),
  );
  await seed(
    `UPDATE agent_interaction_requests SET status='resolved',response=${json(response.response)},resolved_by_user_id=NULL WHERE request_key='invalid-terminal'`,
  );
  await call("resolved row missing audit data rejected", "get", ids(invalid), {
    error: true,
  });
  await seed(
    "DELETE FROM agent_interaction_requests WHERE request_key='invalid-terminal'",
  );
}

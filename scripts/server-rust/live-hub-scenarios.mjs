const user = { kind: "current-user" },
  project = { kind: "project", projectId: "project-one" },
  chat = { kind: "chat", chatId: "chat-one" };
const attach = (socket = "one", owner = "owner-one", session) => ({
  op: "attach",
  socket,
  owner,
  session,
});
const frame = (message, socket = "one") => ({ op: "frame", socket, message });
const initialize = (resume = null, controlCapabilities = []) => ({
  type: "initialize",
  protocolVersion: 1,
  client: {
    id: "fixture-client",
    name: "Cantrip fixture",
    version: "1",
    controlCapabilities,
  },
  resume,
});
const subscribe = (
  requestId = "subscription",
  scopes = [user],
  socket = "one",
) => frame({ type: "subscribe", requestId, scopes }, socket);
const publish = (ownerId = "owner-one", scope = user, extra = {}) => ({
  op: "publish",
  publication: {
    ownerId,
    scope,
    resource: "worker",
    action: "invalidated",
    entityId: null,
    revision: null,
    payload: {},
    ...extra,
  },
});
const ready = (socket = "one", owner = "owner-one", capabilities = []) => [
  attach(socket, owner),
  frame(initialize(null, capabilities), socket),
];
const control = (
  label,
  command = { kind: "focus-project", projectId: "project-one" },
  timeoutMs,
) => ({ op: "control", label, command, timeoutMs });
export function liveHubCases() {
  const cases = [];
  const add = (name, steps, options = {}, extra = {}) =>
    cases.push({ name, steps, options, ...extra });
  add("initialization, request history and scoped fanout", [
    attach(),
    subscribe("before-initialize"),
    frame(initialize()),
    frame(initialize()),
    subscribe(),
    subscribe(),
    subscribe("denied", [{ kind: "project", projectId: "denied" }]),
    subscribe("denied", [user]),
    subscribe("project", [project, project]),
    publish(),
    publish("owner-two"),
    publish("owner-one", project),
    frame({ type: "unsubscribe", requestId: "remove", scopes: [user] }),
    publish(),
    frame({ type: "ping", nonce: "nonce" }),
    { op: "close" },
    attach("after-close"),
  ]);
  for (const [name, raw, binary] of [
    ["invalid-json", "{", false],
    ["binary", '{"type":"ping"}', true],
    ["primitive", "true", false],
    ["unsupported-version", '{"type":"initialize","protocolVersion":2}', false],
    ["missing-version", '{"type":"initialize"}', false],
    [
      "whitespace-request-id",
      '{"type":"subscribe","requestId":"   ","scopes":[]}',
      false,
    ],
    [
      "lone-surrogate-request-id",
      '{"type":"subscribe","requestId":"\\ud800","scopes":[]}',
      false,
    ],
  ])
    add(name, [
      ...ready(),
      ...Array.from({ length: 6 }, () => ({ op: "frame", raw, binary })),
      frame({ type: "ping", nonce: "after-errors" }),
    ]);
  add(
    "oversized text closes after final error",
    [...ready(), { op: "frame", raw: " ".repeat(1025) }],
    { maxInboundBytes: 1024 },
  );
  add(
    "binary takes precedence over size",
    [...ready(), { op: "frame", raw: " ".repeat(1025), binary: true }],
    { maxInboundBytes: 1024 },
  );
  add("request-history eviction", [
    ...ready(),
    ...Array.from({ length: 258 }, (_, i) => subscribe(`request-${i}`)),
    subscribe("request-0"),
    subscribe("request-257"),
  ]);
  add("subscription capacity, duplicate scopes and atomic denial", [
    ...ready(),
    subscribe(
      "full",
      Array.from({ length: 128 }, (_, i) => ({
        kind: "project",
        projectId: `project-${i}`,
      })),
    ),
    subscribe("overflow", [user]),
    subscribe("duplicate", [{ kind: "project", projectId: "project-0" }]),
    frame({
      type: "unsubscribe",
      requestId: "free",
      scopes: [{ kind: "project", projectId: "project-0" }],
    }),
    subscribe("after-free", [user]),
    subscribe("atomic", [project, { kind: "chat", chatId: "denied" }]),
    publish("owner-one", project),
  ]);
  add("UTF16 scopes and bounded payload", [
    ...ready(),
    subscribe("wide", [{ kind: "project", projectId: "project-🦀-\ud800" }]),
    publish(
      "owner-one",
      { kind: "project", projectId: "project-🦀-\ud800" },
      { payload: { "\ud800": [-0, 1e-7, "\udfff", "🦀"] } },
    ),
  ]);
  for (const [name, resume, options, prefix] of [
    [
      "resume scope replay",
      { serverEpoch: "oracle-epoch", cursor: 0 },
      {},
      [publish(), publish("owner-one", project), publish("owner-two")],
    ],
    [
      "resume owner cursor isolation",
      { serverEpoch: "oracle-epoch", cursor: 1 },
      {},
      [publish("owner-two"), publish("owner-two"), publish()],
    ],
    [
      "epoch change",
      { serverEpoch: "other-epoch", cursor: 0 },
      {},
      [publish()],
    ],
    [
      "future cursor",
      { serverEpoch: "oracle-epoch", cursor: 99 },
      {},
      [publish()],
    ],
    [
      "expired replay",
      { serverEpoch: "oracle-epoch", cursor: 0 },
      { maxReplayEvents: 1 },
      [publish(), publish()],
    ],
    [
      "global replay eviction",
      { serverEpoch: "oracle-epoch", cursor: 0 },
      { maxReplayEvents: 1 },
      [publish(), publish("owner-two")],
    ],
    [
      "byte replay eviction",
      { serverEpoch: "oracle-epoch", cursor: 0 },
      { maxReplayBytes: 1 },
      [publish()],
    ],
  ])
    add(
      name,
      [
        ...prefix,
        attach(),
        frame(initialize(resume)),
        subscribe("resume", [user, project]),
        frame({
          type: "resync-ack",
          requestId: "resynced",
          cursor: 1,
          scopes: [user],
        }),
        publish(),
        subscribe("later", [project]),
      ],
      options,
    );
  add("resume remains pending after forbidden scope", [
    publish(),
    attach(),
    frame(initialize({ serverEpoch: "oracle-epoch", cursor: 0 })),
    subscribe("denied", [{ kind: "chat", chatId: "denied" }]),
    publish(),
    subscribe("allowed"),
    publish(),
  ]);
  add(
    "backpressure on publication",
    [
      ...ready(),
      subscribe(),
      { op: "buffer", bytes: 4095 },
      publish(),
      publish(),
    ],
    { maxBufferedBytes: 4096 },
  );
  add(
    "backpressure on protocol response",
    [
      ...ready(),
      { op: "buffer", bytes: 4095 },
      frame({ type: "ping", nonce: "pressure" }),
    ],
    { maxBufferedBytes: 4096 },
  );
  add("send failure disconnects once", [
    ...ready(),
    subscribe(),
    { op: "send-fail" },
    publish(),
    publish(),
    { op: "close" },
  ]);
  add("closed transport is removed on send", [
    ...ready(),
    subscribe(),
    { op: "closed-state" },
    publish(),
    { op: "close" },
  ]);
  add("session and owner revocation", [
    attach("one", "owner-one", "session-one"),
    attach("two", "owner-one", "session-two"),
    attach("three", "owner-two", "session-three"),
    frame(initialize()),
    { op: "revoke-session", session: "session-one" },
    { op: "revoke-session", session: "session-one" },
    { op: "revoke-owner", owner: "owner-one" },
    { op: "revoke-owner", owner: "owner-two" },
  ]);
  for (const value of [false, "error"])
    add(`active callback ${value}`, [
      ...ready(),
      { op: "active", value },
      frame({ type: "ping", nonce: "revoked" }),
      { op: "close" },
    ]);
  add(
    "heartbeat strict boundary",
    [
      ...ready(),
      { op: "advance", ms: 15000 },
      frame({ type: "ping", nonce: "still-alive" }),
      { op: "advance", ms: 15000 },
      { op: "advance", ms: 5000 },
    ],
    { heartbeatIntervalMs: 5000 },
  );
  add(
    "heartbeat without frames",
    [...ready(), { op: "advance", ms: 15000 }, { op: "advance", ms: 5000 }],
    { heartbeatIntervalMs: 5000 },
  );
  add(
    "heartbeat revalidates inactive session",
    [...ready(), { op: "active", value: false }, { op: "advance", ms: 5000 }],
    { heartbeatIntervalMs: 5000 },
  );
  add("control unavailable and unsupported", [
    control("empty"),
    ...ready(),
    subscribe("project", [project]),
    control("unsupported"),
    { op: "close" },
    control("closed"),
  ]);
  add("control ack is tied to selected socket", [
    ...ready("one", "owner-one", ["focus-project"]),
    subscribe("one", [project]),
    ...ready("two", "owner-one", ["focus-project"]),
    subscribe("two", [project], "two"),
    control("focus"),
    { op: "ack", socket: "two", requestSocket: "one" },
    { op: "ack", socket: "one" },
    control("rejected"),
    { op: "ack", status: "rejected" },
  ]);
  add("control prefers chat subscriber", [
    ...ready("one", "owner-one", ["show-interaction"]),
    subscribe("one", [project]),
    ...ready("two", "owner-one", ["show-interaction"]),
    subscribe("two", [project, chat], "two"),
    control("interaction", {
      kind: "show-interaction",
      projectId: "project-one",
      chatId: "chat-one",
      interactionId: "interaction-one",
    }),
    { op: "ack", socket: "two" },
  ]);
  add("control skips inactive candidate", [
    ...ready("one", "owner-one", ["focus-project"]),
    subscribe("one", [project]),
    { op: "active", value: false },
    ...ready("two", "owner-one", ["focus-project"]),
    subscribe("two", [project], "two"),
    control("focus"),
    { op: "ack", socket: "two" },
  ]);
  add("control expiry and disconnect", [
    ...ready("one", "owner-one", ["focus-project"]),
    subscribe("one", [project]),
    control("expired", undefined, 10),
    { op: "advance", ms: 9 },
    { op: "advance", ms: 1 },
    control("disconnected"),
    { op: "disconnect" },
  ]);
  add("control expiry wins over late ack", [
    ...ready("one", "owner-one", ["focus-project"]),
    subscribe("one", [project]),
    control("expired", undefined, 0),
    { op: "advance", ms: 1 },
    { op: "ack" },
  ]);
  add("control pending capacity and shutdown", [
    ...ready("one", "owner-one", ["focus-project"]),
    subscribe("one", [project]),
    ...Array.from({ length: 129 }, (_, i) => control(`control-${i}`)),
    { op: "close" },
  ]);
  add(
    "external publication and confirmation failure",
    [
      ...ready(),
      subscribe(),
      publish(),
      { op: "external", publication: publish().publication },
      { op: "external", publication: null },
      { op: "external", publication: { ownerId: 42 } },
      { op: "external-fail", value: true },
      publish(),
      { ...publish(), op: "publish-confirmed" },
      { op: "close" },
    ],
    {},
    { external: true },
  );
  add("usage invalidations do not notify recursively", [
    ...ready(),
    subscribe(),
    publish("owner-one", user, { resource: "account-resource-usage" }),
    publish(),
  ]);
  for (const depth of [160, 512]) {
    add(`valid JSON with ${depth} nested unknown containers`, [
      ...ready(),
      {
        op: "frame",
        raw: `{"type":"ping","nonce":"deep","extra":${"[".repeat(depth)}0${"]".repeat(depth)}}`,
      },
    ]);
  }
  add("duplicate JSON members use the final value", [
    ...ready(),
    { op: "frame", raw: '{"type":"ping","nonce":"first","nonce":"last"}' },
  ]);
  add("JavaScript JSON number overflow in unknown fields", [
    ...ready(),
    { op: "frame", raw: '{"type":"ping","nonce":"number","extra":1e999}' },
  ]);
  return cases;
}

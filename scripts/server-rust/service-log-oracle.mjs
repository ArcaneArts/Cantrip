import { createServiceLogEmitter } from "../../packages/logging/src/core.ts";
import {
  sanitizeLogText,
  sanitizeLogContext,
  normalizeLogError,
} from "../../packages/logging/src/records.ts";
const cases = [];
const add = (kind, input) =>
  cases.push({
    kind,
    input,
    expected:
      kind === "text"
        ? sanitizeLogText(input)
        : kind === "context"
          ? sanitizeLogContext(input)
          : normalizeLogError(input),
  });
for (let unit = 0; unit <= 65535; unit++)
  add(
    "text",
    String.fromCharCode(unit) + " Authorization: Bearer private-token",
  );
const secrets = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "clientSecret",
  "api_key",
  "apikey",
  "token",
  "accessToken",
  "refresh.token",
  "id-token",
  "bearerToken",
  "providerToken",
  "private_key",
  "credential",
  "csrf",
  "csrfToken",
  "xsrf_token",
  "device_code",
  "oauth-code",
  "pairingCode",
  "enrollment_code",
  "signedUrl",
];
for (const name of secrets) {
  for (const value of [
    "secret-value",
    '"secret with space"',
    "'quoted credential'",
  ])
    for (const separator of ["=", ":", " \t= \u00a0"])
      add("text", `${name}${separator}${value}, ordinary=ok`);
  add("context", {
    event: "test.event",
    [name]: "private-field",
    nested: { [name]: "nested-private", ordinary: "safe" },
  });
}
for (const prefix of [
  "",
  "a",
  "1",
  "_",
  "α",
  "ſ",
  "K",
  "🦀",
  "\ud800",
  "-",
  ".",
  "\u200b",
])
  for (const body of [
    "Bearer abc_123",
    "basic YTpi",
    "baſic encoded-secret",
    "token=quoted",
    "sk-abcdefghijkl",
    "ghp_0123456789",
    "X-Amz-Signature=public",
  ])
    add("text", prefix + body);
for (const url of [
  "https://example.invalid",
  "https://USER:password@example.invalid/a?ordinary=ok&token=private#fragment",
  "https://example.invalid/a?x=%20&y=~",
  "https://example.invalid/a?apiKey=private&x=%20&x=two&apiKey=other#hello",
  "https://example.invalid/a?X-Amz-Signature=private&part=ordinary&part=other&empty",
  "https://example.invalid/a?sig=private&password=hidden&password=other",
  "https://example.invalid/?signature=private&x=%E9%FF",
  "https://:@example.invalid/",
  "https://u:p@[::1]:443/a/../b?q=one%20two",
  "http://user@example.invalid/path",
  "HTTPS://OPENROUTER.AI:443/a/./../b?o=1",
  "https://éxample.invalid/🦀?token=private",
  "https://example.invalid/\ud800?token=x",
  "https://example.invalid./?token=private",
  "https://0x7f000001/",
  "https://bad:port/",
  "https://[bad]/",
  "https://",
])
  add("text", "request " + url);
for (const text of [
  "\u001b[31mred\u001b[0m",
  "\u001b]title\u0007ordinary",
  "\u001b]title\u001b\\ordinary",
  "\u001b]unterminated",
  "safe\nline\ttab\rcarriage",
  "a".repeat(16383) + "🦀",
  "x".repeat(17000),
])
  add("text", text);
for (const value of [
  null,
  false,
  0,
  "",
  [],
  {},
  {
    message: "password=private",
    name: "FixtureError",
    code: 0,
    stack: "never include stack",
    cause: { token: "private" },
  },
  { message: 42, name: false, code: true },
  ["token=private"],
  "Bearer hidden",
  42,
])
  add("error", value);
cases.push({ kind: "error", expected: normalizeLogError(undefined) });
for (const value of [
  null,
  false,
  1,
  "token=private",
  [1, "token=private", { accessToken: "hidden" }],
  Object.fromEntries(
    Array.from({ length: 105 }, (_, i) => [String(104 - i), i]),
  ),
  JSON.parse('{"__proto__":{"password":"private"},"ordinary":"safe"}'),
  { constructor: { prototype: { token: "private" } } },
])
  add("context", value);
let depth = { message: "at depth 8", password: "private" };
for (let i = 0; i < 9; i++) depth = { next: depth };
add("context", depth);
add(
  "context",
  Array.from({ length: 105 }, (_, i) => i),
);
const scenarios = [];
function scenario(name, actions, system = "server", initial = 1700000000000) {
  let now = initial,
    step = 0,
    clockCalls = 0;
  const records = [],
    results = [];
  const logger = createServiceLogEmitter(system, {
    now: () => {
      clockCalls++;
      const at = now;
      now += step;
      return new Date(at);
    },
    onRecord: (record) => records.push(record),
  });
  for (const action of actions) {
    if (action.op === "clock") {
      now = action.now === "invalid" ? NaN : action.now;
      step = action.step ?? 0;
      continue;
    }
    try {
      const {
        key,
        level = "info",
        message = "Event",
        context,
        options,
        every,
      } = action;
      let result;
      if (action.op === "event") result = logger.log(level, message, context);
      else if (action.op === "repeat")
        result = logger.rateLimited(key, level, message, context, options);
      else if (action.op === "sample")
        result = logger.sampled(key, every, level, message, context);
      else if (action.op === "flush") result = logger.flushRepeated(key);
      else throw new Error("Unknown log action");
      results.push({ result: result ?? null });
    } catch (error) {
      results.push({ error: error.message });
    }
  }
  scenarios.push({
    name,
    actions,
    system,
    initial,
    expected: { records, results, clockCalls },
  });
}
scenario("sampling and independent keys", [
  ...Array.from({ length: 45 }, (_, i) => ({
    op: "sample",
    key: i % 2 ? "left" : "right",
    every: 3,
    message: "Sample",
    context: { event: "sample", iteration: i },
  })),
  { op: "flush" },
]);
scenario("repeat thresholds and latest counts", [
  ...Array.from({ length: 14 }, (_, i) => ({
    op: "repeat",
    key: "repeat",
    context: {
      event: "repeated",
      counts: { original: 7, repeated: 99 },
      iteration: i,
    },
    options: { summaryEvery: 3 },
  })),
  { op: "flush" },
  { op: "flush" },
]);
scenario("time boundary level and message replacement", [
  { op: "repeat", key: "same", context: null },
  { op: "repeat", key: "same", context: [1, 2] },
  { op: "clock", now: 1700000029999 },
  { op: "repeat", key: "same", context: { latest: 1 } },
  { op: "clock", now: 1700000030000 },
  { op: "repeat", key: "same" },
  { op: "repeat", key: "same", context: "primitive" },
  { op: "repeat", key: "same", level: "warn", context: 7 },
  { op: "repeat", key: "same", level: "warn", context: { counts: [1, 2] } },
  { op: "repeat", key: "same", level: "warn", message: "Other" },
  { op: "flush" },
]);
scenario("positive-integer option validation", [
  ...[
    -1,
    0,
    1,
    1.5,
    9007199254740991,
    9007199254740992,
    null,
    false,
    "3",
  ].flatMap((value) => [
    { op: "sample", key: "sample", every: value },
    { op: "repeat", key: "rate", options: { windowMs: value } },
    { op: "repeat", key: "rate", options: { summaryEvery: value } },
  ]),
  { op: "repeat", key: "rate", options: null },
  { op: "repeat", key: "rate", options: false },
  { op: "flush" },
]);
scenario("clock calls and backward time", [
  { op: "clock", now: 1700000000000, step: 1 },
  { op: "repeat", key: "r", options: { summaryEvery: 1 } },
  { op: "repeat", key: "r", options: { summaryEvery: 1 } },
  { op: "flush", key: "r" },
  { op: "clock", now: 1699999999999 },
  { op: "repeat", key: "r" },
  { op: "flush" },
]);
scenario("invalid clock and recovery", [
  { op: "clock", now: "invalid" },
  { op: "event" },
  { op: "repeat", key: "r", options: { windowMs: 0 } },
  { op: "sample", key: "s", every: 1 },
  { op: "clock", now: 1700000000000 },
  { op: "sample", key: "s", every: 2 },
  { op: "repeat", key: "r" },
  { op: "clock", now: "invalid" },
  { op: "repeat", key: "r", options: { summaryEvery: 1 } },
  { op: "clock", now: 1700000000000 },
  { op: "flush" },
]);
scenario(
  "UTF16 keys and secret redaction",
  [
    ...Array.from({ length: 6 }, (_, i) => ({
      op: "repeat",
      key: i % 2 ? "key:\ud800" : "key:�",
      message: "Bearer hidden",
      context: { password: "private", ordinary: "safe" },
    })),
    { op: "flush" },
  ],
  "password=private",
);
scenario("FIFO eviction does not refresh existing keys", [
  ...Array.from({ length: 1000 }, (_, i) => ({
    op: "sample",
    key: "s" + i,
    every: 2,
  })),
  { op: "sample", key: "s0", every: 2 },
  { op: "sample", key: "s1000", every: 2 },
  { op: "sample", key: "s0", every: 2 },
  ...Array.from({ length: 1000 }, (_, i) => ({ op: "repeat", key: "r" + i })),
  { op: "repeat", key: "r0" },
  { op: "repeat", key: "r1000" },
  { op: "repeat", key: "r0" },
  { op: "flush", key: "r0" },
  { op: "flush", key: "r1" },
]);
process.stdout.write(JSON.stringify({ cases, scenarios }));

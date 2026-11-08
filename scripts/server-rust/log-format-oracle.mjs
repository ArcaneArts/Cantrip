import {
  formatServiceLog,
  formatHttpLog,
  formatDuration,
  createPinoServiceLogStream,
} from "../../packages/logging/dist/index.js";
const contexts = [
  undefined,
  null,
  0,
  " x  y ",
  [],
  [1, null, true, {}, [null, "x"]],
  { a: { b: { c: "value", stack: "nested" } } },
  { error: { name: "Error", message: "some\n error", stack: "private" } },
  {
    err: { message: "" },
    stack: "skip",
    type: "skip",
    hostname: "skip",
    reqId: "skip",
  },
  {
    2: "two",
    1: "one",
    "01": "leading",
    deep: { 3: "three", 2: "two", leaf: { z: 1, a: 2 } },
  },
  {
    "\ud800": { "strange key": "a\ufeffb\u0085c" },
    array: ["a b", "\udfff", false],
  },
  { array: [{ toString: 7 }] },
];
const services = [];
for (let i = 0; i < 480; i++) {
  const record = {
    timestamp: [
      "2026-11-08T15:34:00.000Z",
      "1970-01-01T00:00:00.000Z",
      "2026-03-08T08:00:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "invalid-date",
    ][i % 5],
    system: ["server", "worker", "custom\ud800"][i % 3],
    level: ["trace", "debug", "info", "warn", "error", "fatal", "unknown"][
      i % 7
    ],
    message: [
      "hello\n\t world",
      "\ufefftrim\u3000me\ufeff",
      "x\u0085y\udfff",
      "",
    ][i % 4],
  };
  if (contexts[i % contexts.length] !== undefined)
    record.context = contexts[i % contexts.length];
  const colors = !!(i % 2);
  let expected, error;
  try {
    expected = formatServiceLog({
      ...record,
      timestamp: new Date(record.timestamp),
      colors,
    });
  } catch (e) {
    error = e.message;
  }
  services.push({ record, colors, expected, error });
}
const http = [];
for (const statusCode of [
  99,
  ...Array.from({ length: 500 }, (_, i) => i + 100),
  700,
  200.5,
])
  for (const colors of [false, true]) {
    const record = {
      timestamp: "2026-11-08T15:34:00.000Z",
      system: "server",
      level: "debug",
      message: "ignored",
      context: {
        method: "GET",
        path: "/api/😀/value",
        durationMs: statusCode % 3 ? 0.499 : 1.999,
        statusCode,
      },
    };
    http.push({
      record,
      colors,
      expected: formatHttpLog({
        ...record.context,
        system: record.system,
        timestamp: new Date(record.timestamp),
        colors,
      }),
    });
  }
const durations = [
  -1,
  -0,
  0,
  Number.MIN_VALUE,
  0.0005,
  0.499,
  0.5,
  0.999,
  1,
  1.999,
  1e20,
  1e21,
  Number.MAX_VALUE,
].map((input) => ({ input, expected: formatDuration(input) }));
const paths = [];
for (const input of [
  "/",
  "/a/../b?token=private",
  "//example.com/a#fragment",
  "http://name:password@host/%2e/a?secret=x",
  "http://[bad?q#f",
  "\\a\\b?private",
  "/api/é/😀",
  "\ud800?x",
  "mailto:a@example.test",
  "/a/%2F/%2e%2e/b",
  " /api/white\nspace?x",
]) {
  const records = [];
  const stream = createPinoServiceLogStream("server", {
    colors: false,
    now: () => new Date("2026-11-08T00:00:00Z"),
    output: () => {},
    onRecord: (record) => records.push(record),
  });
  stream.write(
    JSON.stringify({
      msg: "incoming request",
      reqId: "path-test",
      req: { method: "GET", url: input },
    }),
  );
  stream.write(
    JSON.stringify({
      msg: "request completed",
      reqId: "path-test",
      res: { statusCode: 200 },
      responseTime: 1,
    }),
  );
  paths.push({ input, expected: records[0].context.path });
}
console.log(JSON.stringify({ services, http, durations, paths }));

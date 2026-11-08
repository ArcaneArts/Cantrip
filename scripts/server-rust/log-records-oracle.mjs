import {
  ServiceLogBuffer,
  minimizeServiceLogRecordInput,
} from "../../packages/logging/dist/index.js";
let seed = 817231;
const random = (n) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};
const texts = [
  "server",
  "worker",
  "系統😀",
  "\ud800",
  "Bearer private-token",
  "x".repeat(17000),
];
const context = () => ({
  event: ["worker.connected", "debug.private=secret", "😀".repeat(400)][
    random(3)
  ],
  workerId: texts[random(texts.length)],
  phase: ["open", "bad--stage", "root+child", "Root", "-bad", "bad_"][
    random(6)
  ],
  failureStage: ["valid-stage", "bad+stage", "ok0", "bad--stage"][random(4)],
  lastDestinationRejectionCode: ["unauthorized", "injected private detail"][
    random(2)
  ],
  path: ["/api/resource", "/Users/private/file"][random(2)],
  someCount: [0, 9, 1.5][random(3)],
  someId: "opaque",
  hasAttachment: !!random(2),
  attempt: 2,
  serverVersion: "1.2.3",
  error: {
    name: "SensitiveError",
    message: "private account body",
    code: "E_TEST",
    stack: "private stack",
  },
  password: "must disappear",
  bodyMarkdown: "private body",
  migration: { captured: 4 },
});
const record = () => ({
  timestamp: "2026-11-08T00:00:00.000Z",
  system: texts[random(texts.length)],
  level: ["trace", "debug", "info", "warn", "error", "fatal"][random(6)],
  message: "private human message access_token=secret",
  context: context(),
});
const minima = Array.from({ length: 800 }, () => {
  const input = record();
  return { input, expected: minimizeServiceLogRecordInput(input) };
});
const scenarios = [];
for (let i = 0; i < 16; i++) {
  const options = {
    maxBytes: [1, 160, 512, 4096][i % 4],
    maxEntries: [1, 2, 10, 100][random(4)],
    maxRecordBytes: [32, 128, 512, 1024][random(4)],
  };
  const buffer = new ServiceLogBuffer(options),
    actions = [];
  for (let n = 0; n < 80; n++) {
    const choice = random(7);
    let action;
    if (choice < 3) {
      const input = record();
      action = { op: "append", input, expected: buffer.append(input) };
    } else if (choice === 3) {
      buffer.clear();
      action = { op: "clear", expected: null };
    } else {
      const input = {
        limit: [1, 2, 10, 501][random(4)],
        minimumLevel: ["trace", "warn", "fatal", "unknown"][random(4)],
      };
      if (random(2))
        input.afterCursor = [0, 1, 20, 500, "no-number", null][random(6)];
      if (random(2))
        input.beforeCursor = [1, 20, 500, "no-number", null][random(5)];
      action = { op: "read", input, expected: buffer.read(input) };
    }
    action.stats = {
      byteSize: buffer.byteSize,
      size: buffer.size,
      latestCursor: buffer.latestCursor,
    };
    actions.push(action);
  }
  scenarios.push({ options, actions });
}
console.log(JSON.stringify({ minima, scenarios }));

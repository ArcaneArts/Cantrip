const run = (id = "a") => ({ op: "run", id });
const wait = (id = "a") => ({ op: "wait", id });
const see = (name) => ({ op: "observe", name });
const done = (kind, root, extra = {}) => ({
  op: "complete",
  kind,
  root,
  ...extra,
});
const list = (value) => done("list", undefined, { value });
const fail = (kind, error, root) => done(kind, root, { error });
const advance = (ms) => ({ op: "advance", ms });
const stop = { op: "stop" },
  start = { op: "start" };
const entry = (i) => ({
  ownerId: `o${i}`,
  workerId: `w${i}`,
  chatId: "chat",
  rootOperationId: `r${i}`,
  rootOperationGeneration: `g${i}`,
  attempts: 0,
});
const entries = (n) => Array.from({ length: n }, (_, i) => entry(i));
const success = (i) => [
  done("request", `r${i}`),
  done("ack", `r${i}`, { value: true }),
];
const begin = (rows) => [run(), list(rows)];
export const cases = [
  {
    name: "empty sweep coalesces callers",
    steps: [run(), run("b"), list([]), wait(), wait("b")],
  },
  {
    name: "exact root generation and worker request precede acknowledgment",
    steps: [
      ...begin([entry(0)]),
      see("request pending"),
      done("request", "r0"),
      see("ack pending"),
      done("ack", "r0", { value: true }),
      wait(),
    ],
  },
  {
    name: "eight workers replenish only after durable acknowledgment",
    steps: [
      ...begin(entries(10)),
      see("eight workers"),
      done("request", "r2"),
      see("ack retains slot"),
      done("ack", "r2"),
      see("ninth root"),
      ...[0, 1, 3, 4, 5, 6, 7, 8, 9].flatMap(success),
      wait(),
    ],
  },
  {
    name: "slow first root does not block later roots",
    steps: [
      ...begin(entries(10)),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(success),
      see("first root still pending"),
      ...success(0),
      wait(),
    ],
  },
  {
    name: "failed read reports without an entry and allows another sweep",
    steps: [
      run(),
      fail("list", "read failed"),
      wait(),
      run("b"),
      list([]),
      wait("b"),
    ],
  },
  {
    name: "failed worker reply persists retry",
    steps: [
      ...begin([entry(0)]),
      fail("request", "worker offline", "r0"),
      done("defer", "r0", { value: true }),
      wait(),
    ],
  },
  {
    name: "failed acknowledgment persists retry",
    steps: [
      ...begin([entry(0)]),
      done("request", "r0"),
      fail("ack", "ack failed", "r0"),
      done("defer", "r0"),
      wait(),
    ],
  },
  {
    name: "false acknowledgment is a completed fenced delete",
    steps: [
      ...begin([entry(0)]),
      done("request", "r0"),
      done("ack", "r0", { value: false }),
      wait(),
    ],
  },
  {
    name: "false defer is a completed fenced update",
    steps: [
      ...begin([entry(0)]),
      fail("request", "worker failed", "r0"),
      done("defer", "r0", { value: false }),
      wait(),
    ],
  },
  {
    name: "defer error is reported without losing other workers",
    steps: [
      ...begin(entries(2)),
      fail("request", "request failed", "r0"),
      fail("defer", "defer failed", "r0"),
      ...success(1),
      wait(),
    ],
  },
  ...[-2, -1, 0, 1, 4, 5, 99].map((attempts) => ({
    name: `retry backoff for attempt ${attempts}`,
    steps: [
      ...begin([{ ...entry(0), attempts }]),
      advance(127),
      fail("request", "retry", "r0"),
      done("defer", "r0"),
      wait(),
    ],
  })),
  {
    name: "clock is sampled after error callback",
    clockOnError: 1700000012345,
    steps: [
      ...begin([entry(0)]),
      fail("request", "retry", "r0"),
      done("defer", "r0"),
      wait(),
    ],
  },
  {
    name: "stop is permanent before any read",
    steps: [stop, run(), wait(), start, advance(30000), see("no new work")],
  },
  {
    name: "stop during a query prevents worker requests",
    steps: [run(), stop, list(entries(2)), wait()],
  },
  {
    name: "query failure after stop is suppressed",
    steps: [run(), stop, fail("list", "late query failure"), wait()],
  },
  {
    name: "stop wins in flight worker success without acknowledgment",
    steps: [
      ...begin(entries(9)),
      stop,
      ...Array.from({ length: 8 }, (_, i) => done("request", `r${i}`)),
      wait(),
    ],
  },
  {
    name: "stop wins in flight worker failure without error or defer",
    steps: [
      ...begin([entry(0)]),
      stop,
      fail("request", "late worker failure", "r0"),
      wait(),
    ],
  },
  {
    name: "stop wins acknowledgment failure without defer",
    steps: [
      ...begin([entry(0)]),
      done("request", "r0"),
      stop,
      fail("ack", "late ack failure", "r0"),
      wait(),
    ],
  },
  {
    name: "already pending defer failure is still reported after stop",
    steps: [
      ...begin([entry(0)]),
      fail("request", "request failed", "r0"),
      stop,
      fail("defer", "late defer failure", "r0"),
      wait(),
    ],
  },
  {
    name: "error callback stop does not cancel its current defer",
    stopOnError: true,
    steps: [
      ...begin([entry(0)]),
      fail("request", "request failed", "r0"),
      done("defer", "r0"),
      wait(),
    ],
  },
  {
    name: "manual sweep does not start a timer",
    steps: [
      run(),
      list([]),
      wait(),
      advance(30000),
      see("no implicit schedule"),
    ],
  },
  {
    name: "start coalesces and schedules interval after sweep finishes",
    steps: [
      start,
      start,
      advance(5000),
      see("no timer while pending"),
      list([]),
      advance(999),
      see("not due"),
      advance(1),
      list([]),
      stop,
      advance(30000),
      see("stopped timer"),
    ],
  },
  {
    name: "repeated start runs immediately while one timer remains armed",
    steps: [
      start,
      list([]),
      advance(200),
      start,
      see("second immediate sweep"),
      advance(800),
      see("existing timer coalesced"),
      list([]),
      advance(999),
      see("after completion delay"),
      advance(1),
      list([]),
      stop,
    ],
  },
  {
    name: "custom interval",
    intervalMs: 37,
    steps: [
      start,
      list([]),
      advance(36),
      see("before deadline"),
      advance(1),
      list([]),
      stop,
    ],
  },
  {
    name: "dropping caller does not cancel delivery",
    steps: [
      ...begin([entry(0)]),
      { op: "drop", id: "a" },
      ...success(0),
      see("owned delivery completed"),
    ],
  },
];

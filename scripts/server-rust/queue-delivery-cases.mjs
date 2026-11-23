// Controlled boundaries for the unchanged Source queue delivery service.
const run = (id = "a") => ({ op: "run", id });
const done = (kind, chat, extra = {}) => ({
  op: "complete",
  kind,
  chat,
  ...extra,
});
const query = (kind, value) => done(kind, undefined, { value });
const fail = (kind, error, chat) => done(kind, chat, { error });
const wait = (id = "a") => ({ op: "wait", id });
const see = (name) => ({ op: "observe", name });
const stop = { op: "stop" };
const entry = (i) => ({
  ownerId: `o${i}`,
  chatId: `c${i}`,
  workerId: `w${i}`,
  revision: i + 2,
});
const entries = (n) => Array.from({ length: n }, (_, i) => entry(i));
const success = (i) => [done("request", `c${i}`), done("acknowledge", `c${i}`)];
const begin = (notices = [], dispatches = []) => [
  run(),
  query("dispatches", dispatches),
  query("notifications", notices),
];
export const cases = [
  {
    name: "empty sweep coalesces callers",
    steps: [
      run(),
      run("b"),
      query("notifications", []),
      wait(),
      wait("b"),
      see("recovery is independent"),
      query("dispatches", []),
    ],
  },
  {
    name: "notifications work without recovery configured",
    dispatch: false,
    steps: [run(), query("notifications", [entry(0)]), ...success(0), wait()],
  },
  {
    name: "recovery is independent and coalesces across notice sweeps",
    steps: [
      run(),
      query("dispatches", [entry(0)]),
      query("notifications", []),
      wait(),
      run("b"),
      query("notifications", []),
      wait("b"),
      see("one recovery read"),
      done("dispatch", "c0"),
      run("c"),
      query("dispatches", []),
      query("notifications", []),
      wait("c"),
    ],
  },
  {
    name: "publish precedes request and acknowledgment",
    steps: [
      ...begin([entry(0)]),
      see("request pending"),
      done("request", "c0"),
      see("acknowledgment pending"),
      done("acknowledge", "c0"),
      wait(),
    ],
  },
  {
    name: "eight notification workers replenish after acknowledgment",
    steps: [
      ...begin(entries(10)),
      see("eight active"),
      done("request", "c2"),
      see("ack does not free the slot"),
      done("acknowledge", "c2"),
      see("ninth request"),
      ...[0, 1, 3, 4, 5, 6, 7, 8, 9].flatMap(success),
      wait(),
    ],
  },
  {
    name: "eight recovery workers replenish after a dispatch",
    steps: [
      ...begin([], entries(10)),
      wait(),
      see("eight dispatches"),
      done("dispatch", "c3"),
      see("ninth dispatch"),
      ...[0, 1, 2, 4, 5, 6, 7, 8, 9].map((i) => done("dispatch", `c${i}`)),
    ],
  },
  {
    name: "dispatch error logs and continues recovery",
    steps: [
      ...begin([], entries(9)),
      wait(),
      fail("dispatch", "dispatch failed", "c0"),
      see("replacement dispatch"),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => done("dispatch", `c${i}`)),
    ],
  },
  {
    name: "recovery query failure does not fail notification delivery",
    steps: [
      run(),
      fail("dispatches", "dispatch query failed"),
      query("notifications", [entry(0)]),
      ...success(0),
      wait(),
    ],
  },
  {
    name: "notice query failure leaves recovery running",
    steps: [
      run(),
      query("dispatches", [entry(0)]),
      fail("notifications", "notice query failed"),
      wait(),
      done("dispatch", "c0"),
    ],
  },
  {
    name: "publish failure defers without requesting",
    publishErrors: { c0: "publish failed" },
    steps: [
      ...begin([entry(0)]),
      see("defer pending"),
      done("defer", "c0"),
      wait(),
    ],
  },
  {
    name: "request failure defers then continues",
    steps: [
      ...begin(entries(9)),
      fail("request", "worker disconnected", "c0"),
      see("defer retains slot"),
      done("defer", "c0"),
      see("next request"),
      ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap(success),
      wait(),
    ],
  },
  {
    name: "acknowledgment failure defers",
    steps: [
      ...begin([entry(0)]),
      done("request", "c0"),
      fail("acknowledge", "ack failed", "c0"),
      done("defer", "c0"),
      wait(),
    ],
  },
  {
    name: "defer failure settles sweep while other requests continue",
    steps: [
      ...begin(entries(2)),
      fail("request", "request failed", "c0"),
      fail("defer", "defer failed", "c0"),
      wait(),
      see("second request retained"),
      ...success(1),
    ],
  },
  {
    name: "early failure allows overlapping sweep with separate worker budget",
    steps: [
      ...begin(entries(9)),
      fail("request", "request failed", "c0"),
      fail("defer", "defer failed", "c0"),
      wait(),
      run("b"),
      query("dispatches", []),
      query("notifications", [{ ...entry(20), chatId: "new" }]),
      see("old and new groups active"),
      done("request", "new"),
      done("acknowledge", "new"),
      wait("b"),
      ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap(success),
    ],
  },
  {
    name: "stop before any work is permanent",
    steps: [
      stop,
      run(),
      wait(),
      { op: "start" },
      { op: "advance", ms: 1000 },
      see("nothing started"),
    ],
  },
  {
    name: "stop during queries prevents requests and dispatches",
    steps: [
      run(),
      stop,
      query("dispatches", entries(2)),
      query("notifications", entries(2)),
      wait(),
    ],
  },
  {
    name: "stop while request is pending prevents late acknowledgment",
    steps: [
      ...begin(entries(9)),
      stop,
      ...Array.from({ length: 8 }, (_, i) => done("request", `c${i}`)),
      wait(),
    ],
  },
  {
    name: "stop while failed request is pending prevents late defer",
    steps: [
      ...begin([entry(0)]),
      stop,
      fail("request", "late failure", "c0"),
      wait(),
    ],
  },
  {
    name: "stop while acknowledgment is pending prevents late defer",
    steps: [
      ...begin([entry(0)]),
      done("request", "c0"),
      stop,
      fail("acknowledge", "late ack failure", "c0"),
      wait(),
    ],
  },
  {
    name: "stop while defer is pending preserves its error",
    steps: [
      ...begin([entry(0)]),
      fail("request", "request failed", "c0"),
      stop,
      fail("defer", "late defer failure", "c0"),
      wait(),
    ],
  },
  {
    name: "stop while dispatch is pending preserves error and prevents further dispatch",
    steps: [
      ...begin([], entries(9)),
      wait(),
      stop,
      fail("dispatch", "late dispatch failure", "c0"),
      ...[1, 2, 3, 4, 5, 6, 7].map((i) => done("dispatch", `c${i}`)),
    ],
  },
  {
    name: "synchronous publish stop still sends current request",
    stopOnPublish: true,
    steps: [...begin(entries(2)), done("request", "c0"), wait()],
  },
  {
    name: "start runs immediately and interval coalesces",
    steps: [
      { op: "start" },
      { op: "start" },
      see("immediate and one timer"),
      { op: "advance", ms: 999 },
      see("not due"),
      { op: "advance", ms: 1 },
      see("pending sweep coalesced"),
      query("dispatches", []),
      query("notifications", []),
      { op: "advance", ms: 1000 },
      see("next sweep"),
      query("dispatches", []),
      query("notifications", []),
      stop,
      { op: "advance", ms: 1000 },
      { op: "start" },
      see("timer removed"),
    ],
  },
  {
    name: "start during manual sweep reuses it",
    steps: [
      run(),
      { op: "start" },
      query("dispatches", []),
      query("notifications", []),
      wait(),
      stop,
    ],
  },
];

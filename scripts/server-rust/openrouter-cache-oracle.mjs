import { OpenRouterCatalogCache } from "../../cantrip_server/src/models/openrouter-catalog.ts";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
};
const steps = {
  read: (
    id,
    key = "public",
    force = false,
    base = "https://openrouter.ai/api/v1?discard=1#fragment",
  ) => ({ op: "read", id, key, force, base }),
  request: (index) => ({ op: "request", index }),
  headers: (index, status = 200, etag = null, statusText = "OK") => ({
    op: "headers",
    index,
    status,
    etag,
    statusText,
  }),
  body: (index, value) => ({ op: "body", index, value }),
  waitBody: (index) => ({ op: "wait-body", index }),
  wait: (id) => ({ op: "wait", id }),
  background: (id) => ({ op: "background", id }),
  clock: (now) => ({ op: "clock", now }),
};
const { read, request, headers, body, waitBody, wait, background, clock } =
  steps;
const models = {
  data: [
    null,
    [],
    {},
    { id: " " },
    { id: " model ", name: "Visible", raw: { public: true } },
    { id: "\ud800", extra: 1 },
  ],
};
const initial = [
  read("first"),
  request(0),
  headers(0, 200, '"first"'),
  waitBody(0),
  body(0, models),
  wait("first"),
];
const cases = [
  {
    name: "fresh, exact TTL, stale return before body, etag 304 retains body and old tag",
    steps: [
      ...initial,
      clock(1099),
      read("fresh"),
      wait("fresh"),
      clock(1100),
      read("stale"),
      wait("stale"),
      request(1),
      headers(1, 304, '"ignored"', "Not Modified"),
      background("stale"),
      read("after"),
      wait("after"),
    ],
  },
  {
    name: "same-key forced concurrent reads share first URL, independent keys, fetchedAt precedes JSON",
    steps: [
      read("a", "same", true, "https://openrouter.ai/a///?x#y"),
      request(0),
      read("b", "same", true, "https://openrouter.ai/ignored"),
      read("c", "other", true),
      request(1),
      clock(2000),
      headers(0, 200, ""),
      waitBody(0),
      clock(3000),
      body(0, models),
      wait("a"),
      wait("b"),
      headers(1),
      waitBody(1),
      body(1, { data: [] }),
      wait("c"),
      clock(2001),
      read("future", "same"),
      wait("future"),
    ],
  },
  {
    name: "cold fetch failure clears shared promise and can retry",
    steps: [
      read("a"),
      request(0),
      read("b"),
      { op: "fetch-error", index: 0, error: "network \ud800" },
      wait("a"),
      wait("b"),
      read("retry"),
      request(1),
      headers(1),
      waitBody(1),
      body(1, models),
      wait("retry"),
    ],
  },
  {
    name: "forced failure retains last good cache and original UTF16 reason",
    steps: [
      ...initial,
      read("force", "public", true),
      request(1),
      headers(1, 503, null, "Unavailable \ud800"),
      wait("force"),
      read("retained"),
      wait("retained"),
    ],
  },
  {
    name: "stale refresh failure remains stale, next refresh can replace models and etag",
    steps: [
      ...initial,
      clock(1100),
      read("stale"),
      wait("stale"),
      request(1),
      headers(1, 200, '"bad"'),
      waitBody(1),
      body(1, []),
      background("stale"),
      read("retry"),
      wait("retry"),
      request(2),
      headers(2, 200, '"next"'),
      waitBody(2),
      body(2, { data: [{ id: " replacement " }] }),
      background("retry"),
      read("new"),
      wait("new"),
    ],
  },
  {
    name: "empty cache 304 rejects, response body is not consumed",
    steps: [
      read("missing"),
      request(0),
      headers(0, 304, null, "Not Modified"),
      wait("missing"),
    ],
  },
  {
    name: "JSON rejection preserves error and cache can retry",
    steps: [
      read("a"),
      request(0),
      headers(0),
      waitBody(0),
      { op: "body-error", index: 0, error: "Invalid JSON \udfff" },
      wait("a"),
      read("retry"),
      request(1),
      headers(1),
      waitBody(1),
      body(1, { data: [] }),
      wait("retry"),
    ],
  },
  {
    name: "TTL zero and negative force revalidation, empty etag is not sent",
    ttl: 0,
    steps: [
      ...initial,
      read("stale"),
      wait("stale"),
      request(1),
      headers(1, 200, ""),
      waitBody(1),
      body(1, models),
      background("stale"),
      read("no-etag"),
      wait("no-etag"),
      request(2),
      headers(2, 304, "unused"),
      background("no-etag"),
    ],
  },
];
for (const payload of [
  null,
  [],
  false,
  {},
  { data: null },
  { data: {} },
  { data: [] },
  {
    data: [
      { id: 1 },
      { id: false },
      { id: [] },
      { id: "\uFEFF keep \u2029", name: "" },
    ],
  },
])
  cases.push({
    name: "payload parsing " + JSON.stringify(payload),
    steps: [
      read("a"),
      request(0),
      headers(0),
      waitBody(0),
      body(0, payload),
      wait("a"),
    ],
  });
for (const base of [
  "mailto:model@example.com?x#y",
  "custom://host/a///?x#y",
  "https://openrouter.ai/%2F///?q#h",
  "https://user:password@openrouter.ai/a",
  "invalid",
])
  cases.push({
    name: "URL construction " + base,
    steps:
      base === "invalid"
        ? [read("a", "public", false, base), wait("a")]
        : [
            read("a", "public", false, base),
            request(0),
            headers(0),
            waitBody(0),
            body(0, { data: [] }),
            wait("a"),
          ],
  });

async function run(input) {
  let now = 1000;
  const pending = [],
    reads = new Map(),
    result = [],
    requests = [];
  let requestChanged = deferred();
  const cache = new OpenRouterCatalogCache({
    now: () => now,
    ttlMs: input.ttl ?? 100,
    fetch: async (url, init) => {
      const reply = deferred(),
        payload = deferred(),
        bodyStarted = deferred();
      pending.push({ reply, payload, bodyStarted });
      requests.push({
        url: String(url),
        etag: new Headers(init.headers).get("if-none-match"),
        accept: new Headers(init.headers).get("accept"),
      });
      requestChanged.resolve();
      requestChanged = deferred();
      const response = await reply.promise;
      return {
        ...response,
        ok: response.status >= 200 && response.status < 300,
        headers: new Headers(
          response.etag === null ? {} : { etag: response.etag },
        ),
        json: () => {
          bodyStarted.resolve();
          return payload.promise;
        },
      };
    },
  });
  for (const step of input.steps) {
    switch (step.op) {
      case "clock":
        now = step.now;
        break;
      case "read": {
        const promise = cache.read({
          baseUrl: step.base,
          cacheKey: step.key,
          force: step.force,
        });
        void promise.then(
          (read) => {
            void read.backgroundRefresh?.catch(() => {});
          },
          () => {},
        );
        reads.set(step.id, promise);
        break;
      }
      case "request":
        while (pending.length <= step.index) await requestChanged.promise;
        break;
      case "headers":
        pending[step.index].reply.resolve(step);
        break;
      case "fetch-error":
        pending[step.index].reply.reject(new Error(step.error));
        break;
      case "wait-body":
        await pending[step.index].bodyStarted.promise;
        break;
      case "body":
        pending[step.index].payload.resolve(step.value);
        break;
      case "body-error":
        pending[step.index].payload.reject(new Error(step.error));
        break;
      case "wait":
        try {
          const read = await reads.get(step.id);
          result.push({
            id: step.id,
            value: {
              snapshot: read.snapshot,
              servedStale: read.servedStale,
              background: !!read.backgroundRefresh,
            },
          });
        } catch (error) {
          result.push({ id: step.id, error: error.message });
        }
        break;
      case "background":
        try {
          const read = await reads.get(step.id);
          result.push({
            id: step.id,
            background: await read.backgroundRefresh,
          });
        } catch (error) {
          result.push({ id: step.id, error: error.message });
        }
        break;
      default:
        throw new Error("Unexpected step " + step.op);
    }
  }
  return { result, requests };
}
for (let id = 0; id < cases.length; id++)
  console.log(
    JSON.stringify({ id, input: cases[id], expected: await run(cases[id]) }),
  );
console.log(JSON.stringify({ done: cases.length }));

import { OpenRouterRuntimeCatalogHydrator } from "../../cantrip_server/src/models/openrouter-runtime-catalog.ts";
import { AsyncLocalStorage } from "node:async_hooks";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
};
const runtime = (
  id,
  kind = "openai-compatible",
  baseUrl = "https://openrouter.ai/api/v1",
) => ({ provider: { id, kind, baseUrl } });
const start = (id, providers) => ({
  op: "start",
  id,
  runtimes: providers.map((p) => (typeof p === "string" ? runtime(p) : p)),
});
const load = (index) => ({ op: "load", index });
const resolve = (index, value) => ({ op: "resolve", index, value });
const reject = (index, error) => ({ op: "reject", index, error });
const wait = (id) => ({ op: "wait", id });
const invalidate = (provider) => ({ op: "invalidate", provider });
const mark = (provider) => ({ op: "mark", provider });
const cases = [
  {
    name: "request owners stay bound across shared work and a different owner's retry",
    trackOwners: true,
    steps: [
      { ...start("a", ["one"]), owner: "owner-a" },
      load(0),
      { ...start("b", ["one", "two"]), owner: "owner-b" },
      load(1),
      resolve(0, false),
      resolve(1, true),
      wait("a"),
      wait("b"),
      { ...start("retry", ["one", "two"]), owner: "owner-b" },
      load(2),
      resolve(2, true),
      wait("retry"),
    ],
  },
  {
    name: "coalesces concurrent duplicate routes, invalidation and false retry",
    steps: [
      start("a", ["one", "one"]),
      load(0),
      start("b", ["one"]),
      resolve(0, true),
      wait("a"),
      wait("b"),
      start("fresh", ["one"]),
      wait("fresh"),
      invalidate("one"),
      start("false", ["one"]),
      load(1),
      resolve(1, false),
      wait("false"),
      start("retry", ["one"]),
      load(2),
      resolve(2, true),
      wait("retry"),
    ],
  },
  {
    name: "ignores other provider kinds and hosts",
    steps: [
      start("empty", []),
      wait("empty"),
      start("ignored", [
        runtime("custom", "openai-compatible", "https://fixture.invalid"),
        runtime("grok", "grok"),
        runtime("ollama", "ollama"),
        runtime(
          "lookalike",
          "openai-compatible",
          "https://openrouter.ai.evil.example",
        ),
      ]),
      wait("ignored"),
    ],
  },
  {
    name: "accepts subdomain and non-HTTP URL provider identity",
    steps: [
      start("a", [
        runtime("sub", "openai-compatible", "https://api.openrouter.ai/v1"),
        runtime("ftp", "openai-compatible", "ftp://openrouter.ai/"),
      ]),
      load(0),
      load(1),
      resolve(0, false),
      resolve(1, true),
      wait("a"),
      start("retry", ["sub", "ftp"]),
      load(2),
      resolve(2, true),
      wait("retry"),
    ],
  },
  {
    name: "mark is retained when active load returns false",
    steps: [
      start("a", ["one"]),
      load(0),
      mark("one"),
      start("marked", ["one"]),
      wait("marked"),
      resolve(0, false),
      wait("a"),
      start("after", ["one"]),
      wait("after"),
    ],
  },
  {
    name: "invalidation does not fence active completion",
    steps: [
      start("a", ["one"]),
      load(0),
      invalidate("one"),
      resolve(0, true),
      wait("a"),
      start("after", ["one"]),
      wait("after"),
    ],
  },
  {
    name: "rejection clears shared load and preserves original error",
    steps: [
      start("a", ["one"]),
      load(0),
      start("b", ["one"]),
      reject(0, "metadata \ud800 failure"),
      wait("a"),
      wait("b"),
      start("retry", ["one"]),
      load(1),
      resolve(1, true),
      wait("retry"),
    ],
  },
  {
    name: "other provider continues after aggregate rejection",
    steps: [
      start("a", ["one", "two"]),
      load(0),
      load(1),
      reject(0, "first provider unavailable"),
      wait("a"),
      start("finish-two", ["two"]),
      resolve(1, true),
      wait("finish-two"),
      start("retry", ["one", "two"]),
      load(2),
      resolve(2, false),
      wait("retry"),
    ],
  },
  {
    name: "unobserved caller still finishes hydration",
    steps: [
      start("unobserved", ["one"]),
      load(0),
      resolve(0, true),
      { op: "settle" },
      start("fresh", ["one"]),
      wait("fresh"),
    ],
  },
  {
    name: "map identities retain UTF16 and prototype keys",
    steps: [
      mark("__proto__"),
      start("a", ["__proto__", "\ud800", "�", "\ud800"]),
      load(0),
      load(1),
      resolve(0, true),
      resolve(1, false),
      wait("a"),
      start("retry", ["\ud800", "�"]),
      load(2),
      resolve(2, true),
      wait("retry"),
    ],
  },
];
async function run(input) {
  const owners = new AsyncLocalStorage();
  const pending = [],
    calls = [],
    results = [],
    reads = new Map();
  let changed = deferred();
  const hydrator = new OpenRouterRuntimeCatalogHydrator((provider) => {
    const reply = deferred();
    pending.push(reply);
    calls.push(
      input.trackOwners
        ? { provider, owner: owners.getStore() ?? null }
        : provider,
    );
    changed.resolve();
    changed = deferred();
    return reply.promise;
  });
  for (const step of input.steps) {
    switch (step.op) {
      case "start": {
        const read = owners.run(step.owner ?? null, () =>
          hydrator.hydrate(step.runtimes),
        );
        void read.catch(() => {});
        reads.set(step.id, read);
        break;
      }
      case "load":
        while (pending.length <= step.index) await changed.promise;
        break;
      case "resolve":
        pending[step.index].resolve(step.value);
        break;
      case "reject":
        pending[step.index].reject(new Error(step.error));
        break;
      case "invalidate":
        hydrator.invalidate(step.provider);
        break;
      case "mark":
        hydrator.markHydrated(step.provider);
        break;
      case "settle":
        await new Promise(setImmediate);
        break;
      case "wait":
        try {
          results.push({ id: step.id, value: await reads.get(step.id) });
        } catch (error) {
          results.push({ id: step.id, error: error.message });
        }
        break;
      default:
        throw new Error("Unknown hydration step");
    }
  }
  return { results, calls };
}
for (let id = 0; id < cases.length; id++)
  console.log(
    JSON.stringify({ id, input: cases[id], expected: await run(cases[id]) }),
  );
console.log(JSON.stringify({ done: cases.length }));

import assert from "node:assert/strict";
import { request } from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { LiveProbe, deadline } from "./live-sockets.mjs";
import { eventually } from "./full-worker.mjs";
const gate = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
// Node's fetch has its own five-minute header deadline. This raw HTTP client
// lets the actual twelve-minute server deadline run, with the caller's signal.
export function longFetch(target, options) {
  return new Promise((resolve, reject) => {
    const caller = request(
      target,
      {
        method: options.method,
        headers: Object.fromEntries(new Headers(options.headers)),
        signal: options.signal,
        agent: false,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers))
            for (const item of Array.isArray(value)
              ? value
              : value === undefined
                ? []
                : [value])
              headers.append(key, item);
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers,
            }),
          );
        });
      },
    );
    caller.setTimeout(0);
    caller.on("error", reject);
    caller.end(options.body);
  });
}
const headers = (f) => {
  const client = f.client();
  return {
    origin: "http://127.0.0.1:5173",
    cookie: [...client.cookies].map(([k, v]) => k + "=" + v).join("; "),
    ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
  };
};
const events = (live, offset, f) =>
  live.frames
    .slice(offset)
    .filter(
      (v) => v.type === "event" && ["worker", "worktree"].includes(v.resource),
    )
    .map(({ cursor, ...v }) => f.normalize(v));

export async function workerOperationLifecycle({
  f,
  worker,
  live,
  state,
  snapshot,
  settle,
  visit,
  actions,
  result,
  evidence,
  normalize,
  replaceLive,
  project,
}) {
  result.lifecycle = {};
  const [, , web] = actions,
    entered = gate(),
    release = gate(),
    failed = gate(),
    closed = gate();
  const before = await snapshot(),
    completed = state.completed,
    commandOffset = state.commands.length;
  await live.ping("before caller destruction");
  const eventOffset = live.frames.length,
    errors = [];
  state.intercept = async (command) => {
    if (command.type === "web-runtime.action") {
      entered.resolve();
      await release.promise;
    }
  };
  const raw = JSON.stringify(web[3].json);
  const caller = request(f.server.origin + web[2], {
    method: "POST",
    headers: {
      ...headers(f),
      "content-type": "application/json",
      "content-length": Buffer.byteLength(raw),
      connection: "close",
    },
  });
  caller.on("error", (error) => {
    errors.push(error.code);
    failed.resolve(error);
  });
  caller.on("close", () => closed.resolve());
  caller.on("response", (response) => {
    response.resume();
    failed.resolve(
      new Error(
        "Request finished before caller destruction: " + response.statusCode,
      ),
    );
  });
  try {
    caller.end(raw);
    await deadline(
      Promise.race([
        entered.promise,
        failed.promise.then((error) => {
          throw error;
        }),
      ]),
      "admitted endpoint request",
    );
    caller.destroy();
    await deadline(closed.promise, "destroyed HTTP caller");
    release.resolve();
    delete state.intercept;
    await eventually(
      () => state.completed,
      (count) => assert.equal(count, completed + 1),
    );
    await settle("after abandoned web action", "GET", actions[0][2]);
    const after = await snapshot();
    assert.deepEqual(after, before);
    await live.ping("after caller destruction");
    result.lifecycle.abandoned = {
      commands: state.commands.slice(commandOffset),
      events: events(live, eventOffset, f),
      before: normalize(before, f),
      after: normalize(after, f),
    };
    await writeFile(
      path.join(evidence, "caller-loss.json"),
      JSON.stringify(
        { before, after, errors, ...result.lifecycle.abandoned },
        null,
        2,
      ) + "\n",
    );
  } finally {
    release.resolve();
    delete state.intercept;
    caller.destroy();
  }
  await settle(
    "ordinary capacity after caller loss",
    actions[1][1],
    actions[1][2],
    actions[1][3],
  );

  const retained = await snapshot(),
    port = +new URL(f.server.origin).port;
  result.beforeReopenDiagnostics = f.server.diagnostics();
  worker.close();
  await live.close();
  replaceLive(null);
  await f.close();
  Object.assign(f.environment, {
    CANTRIP_ACCOUNT_COMMAND_RATE_PER_MINUTE: "60",
    CANTRIP_WORKER_COMMAND_RATE_PER_MINUTE: "60",
    CANTRIP_ACCOUNT_COMMAND_CONCURRENCY: "1",
    CANTRIP_WORKER_COMMAND_CONCURRENCY: "1",
  });
  await f.start({ port });
  const reopened = await snapshot();
  assert.deepEqual(reopened, retained);
  result.lifecycle.reopened = {
    before: normalize(retained, f),
    after: normalize(reopened, f),
  };
  await worker.start();
  live = new LiveProbe(f);
  replaceLive(live);
  await live.opened;
  await live.initialized();
  await live.subscribed("reopened maintenance", [
    { kind: "current-user" },
    { kind: "project", projectId: project },
  ]);
  await settle(
    "retained worker credential after restart",
    "GET",
    actions[0][2],
  );

  const busy = gate(),
    resume = gate();
  state.intercept = async (command) => {
    if (command.type === "web-runtime.action") {
      busy.resolve();
      await resume.promise;
    }
  };
  result.admissionAttempts = [];
  let admitted;
  for (let attempt = 0; attempt < 128; attempt++) {
    const response = fetch(f.server.origin + web[2], {
      method: "POST",
      headers: { ...headers(f), "content-type": "application/json" },
      body: JSON.stringify(web[3].json),
      signal: AbortSignal.timeout(15000),
    });
    const first = await deadline(
      Promise.race([
        busy.promise.then(() => ({ entered: true })),
        response.then((value) => ({ response: value })),
      ]),
      "runtime command admission",
    );
    if (first.entered) {
      admitted = response;
      break;
    }
    const body = await first.response.json();
    assert.equal(first.response.status, 429);
    assert.match(body.error, /concurrency limit reached/);
    result.admissionAttempts.push({ status: first.response.status, body });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(admitted, "The controlled runtime action is actually admitted");
  try {
    await deadline(busy.promise, "actual occupied ordinary command slot");
    await settle("ordinary slot exhausted", actions[1][1], actions[1][2], {
      status: 429,
    });
    await settle("version control remains usable", "GET", actions[0][2]);
  } finally {
    resume.resolve();
    delete state.intercept;
  }
  await visit("held runtime action", web[1], web[2], {
    ...web[3],
    fetcher: () => admitted,
  });
  const published = await live.message(
    (frame) =>
      frame.type === "event" &&
      frame.resource === "worker" &&
      frame.entityId === "alpha",
  );
  const { cursor, ...publication } = published;
  result.lifecycle.heldResponsePublication = f.normalize(publication);
  await settle("command capacity recovers", actions[1][1], actions[1][2], {
    ...actions[1][3],
    fetcher: async (...args) => {
      for (let attempt = 0; attempt < 128; attempt++) {
        const response = await fetch(...args);
        if (response.status !== 429) return response;
        const body = await response.clone().json();
        assert.match(body.error, /concurrency limit reached/);
        result.admissionAttempts.push({ status: response.status, body });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Ordinary command capacity did not recover");
    },
  });

  result.quotaWarmup = [];
  const rateMessage = "Worker command rate limit reached. Retry shortly.";
  for (let index = 0; index < 256; index++) {
    const response = await fetch(f.server.origin + actions[1][2], {
      method: "POST",
      headers: headers(f),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    assert.ok([202, 429].includes(response.status), JSON.stringify(body));
    result.quotaWarmup.push({
      status: response.status,
      body,
      headers: Object.fromEntries(response.headers),
    });
    if (response.status === 429 && body.error === rateMessage) break;
    if (response.status === 429) {
      assert.match(body.error, /concurrency limit reached/);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.equal(result.quotaWarmup.at(-1).status, 429);
  assert.equal(result.quotaWarmup.at(-1).body.error, rateMessage);
  await settle("actual command rate limit", actions[1][1], actions[1][2], {
    status: 429,
    fetcher: async (...args) => {
      const response = await fetch(...args);
      assert.equal(
        response.headers.get("retry-after"),
        null,
        "Caught Source worker failures do not add Retry-After",
      );
      return response;
    },
  });
}

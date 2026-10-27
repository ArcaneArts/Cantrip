// Test-only loopback routes observing the real Node WorkerBridge.
export function installWorkerIngressFixture(app, bridge) {
  const started = [],
    completed = [],
    settled = {},
    gates = new Map(),
    subscriptions = new Map();
  function gate(key) {
    if (!gates.has(key)) {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      gates.set(key, { promise, release });
    }
    return gates.get(key);
  }
  app.get("/__worker_ingress/state", async () => ({
    started,
    completed,
    settled,
    stats: bridge.stats(),
  }));
  app.post("/__worker_ingress/release", async ({ body }) => {
    gate(body.key).release();
    return { ok: true };
  });
  app.post("/__worker_ingress/subscribe", async ({ body }) => {
    subscriptions.get(body.key)?.();
    const listener = async (value) => {
      started.push({ kind: "notification", key: body.key, value });
      if (body.hold) await gate(body.key).promise;
      if (body.fail) throw new Error("Controlled notification failure");
      completed.push({ kind: "notification", key: body.key, value });
    };
    subscriptions.set(
      body.key,
      bridge.subscribeNotifications(body.workerId, listener),
    );
    return { ok: true };
  });
  app.post("/__worker_ingress/unsubscribe", async ({ body }) => {
    subscriptions.get(body.key)?.();
    subscriptions.delete(body.key);
    return { ok: true };
  });
  app.post("/__worker_ingress/request", async ({ body }) => {
    settled[body.key] = false;
    let count = 0;
    try {
      const result = await bridge.request(body.workerId, body.command, {
        timeoutMs: body.timeoutMs ?? 2000,
        onEvent: async (value) => {
          started.push({ kind: "event", key: body.key, value });
          if (body.hold && ++count === 1) await gate(body.key).promise;
          if (body.fail) throw new Error("Controlled event failure");
          completed.push({ kind: "event", key: body.key, value });
        },
      });
      return {
        ok: true,
        resultPresent: result !== undefined,
        ...(result !== undefined ? { result } : {}),
      };
    } catch (error) {
      return { ok: false, message: error.message, code: error.code ?? null };
    } finally {
      settled[body.key] = true;
    }
  });
  return () => {
    for (const current of gates.values()) current.release();
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
  };
}

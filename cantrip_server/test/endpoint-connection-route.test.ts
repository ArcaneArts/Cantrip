import { nativeEndpointProviderKinds } from "@cantrip/protocol";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import {
  installSettingsRouteRuntime,
  type SettingsRouteRuntimeDependencies,
} from "../src/app/runtime/settings-routes.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(kind: string) {
  const provider = {
    id: "instance-a",
    name: "Office",
    kind,
    baseUrl: "http://gpu.lan/proxy/v1",
    apiKey: null,
  };
  const runtime = {
    provider,
    model: { id: "profile-a", name: "manual-model", routeId: "route-a" },
  };
  const request = vi.fn().mockResolvedValue({ accepted: true, durationMs: 1 });
  const getModelRuntimes = vi
    .fn()
    .mockResolvedValue([
      { ...runtime, provider: { ...provider, id: "instance-b" } },
      runtime,
    ]);
  const app = Fastify();
  apps.push(app);
  const installed = installSettingsRouteRuntime(app, {
    applicationOwnerId: () => "owner-a",
    repository: {
      getModelProvider: async (owner: string, id: string) =>
        owner === "owner-a" && id === provider.id ? provider : null,
      getModelRuntimes,
      getUserSettings: async () => ({ defaultWorkerId: "worker-local" }),
      listWorkers: async () => [
        { workerId: "worker-local" },
        { workerId: "worker-lan" },
      ],
    },
    bridge: {
      request,
      isConnected: (id: string) =>
        ["worker-local", "worker-lan", "foreign-worker"].includes(id),
    },
  } as unknown as SettingsRouteRuntimeDependencies);
  app.addHook("onClose", async () =>
    clearInterval(installed.workerCatalogRefreshTimer),
  );
  return { app, provider, runtime, request, getModelRuntimes };
}

it.each(["ollama", ...nativeEndpointProviderKinds])(
  "tests %s by dispatching real inference on the selected owned worker, without discovery",
  async (kind) => {
    const { app, runtime, request } = setup(kind);
    const response = await app.inject({
      method: "POST",
      url: "/api/settings/providers/instance-a/test?workerId=worker-lan",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      stage: "completed",
      workerId: "worker-lan",
      modelName: "manual-model",
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "worker-lan",
      { type: "model.provider.test", ...runtime },
      { ownerId: "owner-a", timeoutMs: 120_000 },
    );
  },
);

it("does not dispatch a test to a connected worker belonging to another owner", async () => {
  const { app, request } = setup("vllm");
  const response = await app.inject({
    method: "POST",
    url: "/api/settings/providers/instance-a/test?workerId=foreign-worker",
  });
  expect(response.json()).toMatchObject({
    ok: false,
    stage: "worker-placement",
  });
  expect(request).not.toHaveBeenCalled();
});

it("reports actual inference failures without leaking the backend body or credential", async () => {
  const { app, request } = setup("lm-studio");
  request.mockRejectedValue(
    new Error("unexpected status 401 at http://secret@host body=private-reply"),
  );
  const response = await app.inject({
    method: "POST",
    url: "/api/settings/providers/instance-a/test",
  });
  expect(response.json()).toMatchObject({
    ok: false,
    stage: "key-authentication",
    message: "LM Studio rejected authentication. HTTP 401.",
  });
  expect(response.body).not.toContain("secret");
  expect(response.body).not.toContain("private-reply");
});

it.each(["chatgpt", "grok"])(
  "preserves %s account status rather than dispatching endpoint inference",
  async (kind) => {
    const { app, request, getModelRuntimes } = setup(kind);
    const response = await app.inject({
      method: "POST",
      url: "/api/settings/providers/instance-a/test",
    });
    expect(response.statusCode).toBe(409);
    expect(request).not.toHaveBeenCalled();
    expect(getModelRuntimes).not.toHaveBeenCalled();
  },
);

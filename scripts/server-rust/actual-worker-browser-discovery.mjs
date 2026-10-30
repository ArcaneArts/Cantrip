// The production worker enumerates OS listeners and probes an actual HTTP service.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

export async function actualWorkerBrowserDiscovery({
  page,
  surface,
  workerId,
  result,
}) {
  const title = "Cantrip discovery " + randomUUID();
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><title>" + title + "</title><p>Discovery fixture</p>",
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  result.browserServiceDiscovery = { port, requests, completed: false };
  try {
    const values = await page.evaluate(
      async ({ id, projectId }) => {
        const api = await import("/src/lib/api/surfaces.ts");
        return {
          services: await api.getBrowserServices(id),
          fleet: await api.getProjectBrowserServices(projectId),
        };
      },
      { id: surface.id, projectId: surface.projectId },
    );
    // Retain both actual replies even if the subsequent identity assertion fails.
    result.browserServiceDiscovery.services = values.services;
    result.browserServiceDiscovery.fleet = values.fleet;
    const found = values.services.find(
      (s) => s.port === port && s.title === title,
    );
    assert.ok(
      found,
      "Actual listener discovered through the existing browser client API",
    );
    assert.equal(found.workerId, workerId);
    assert.equal(found.host, "127.0.0.1");
    assert.equal(found.protocol, "http");
    assert.equal(found.statusCode, 200);
    const worker = values.fleet.workers.find((w) => w.workerId === workerId);
    assert.equal(worker?.status, "ok");
    const fleet = worker.services.find(
      (s) => s.port === port && s.title === title,
    );
    assert.ok(
      fleet,
      "Same actual listener discovered through the project fleet API",
    );
    assert.equal(fleet.workerId, workerId);
    assert.deepEqual(fleet.placement, {
      projectId: surface.projectId,
      workerId,
      projectReplicaId: null,
      worktreeId: null,
      surface: null,
    });
    assert.ok(
      requests.filter((r) => r.method === "GET").length >= 2,
      "Both real worker commands probed the listener",
    );
    result.browserServiceDiscovery.completed = true;
    result.browserServiceDiscovery.service = found;
    result.browserServiceDiscovery.fleetService = fleet;
    result.steps.push(
      "existing browser and project discovery APIs find a real HTTP listener through the unchanged full worker's OS scan and probes",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

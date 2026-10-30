// Existing browser crypto/API modules and the full worker. The terminal uses
// the managed folder created by the preceding actual product flow.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./full-worker.mjs";
import { actualWorkerObservations } from "./actual-worker-observations.mjs";
import { actualWorkerTerminalLink } from "./actual-worker-terminal-link.mjs";
import { actualWorkerTerminalRelay } from "./actual-worker-terminal-relay.mjs";
import { actualWorkerTerminalDirect } from "./actual-worker-terminal-direct.mjs";

export async function actualTerminalServices({
  page,
  projectId,
  directory,
  workerId,
  startWorker,
  stopWorker,
  result,
  workerLinks = false,
  workerLinkRoute = "relay",
  directBrokerBinary,
}) {
  const proof = path.join(directory, "terminal-proof.jsonl"),
    secret = "private-terminal-command-" + crypto.randomUUID();
  const program = `terminal-service-probe-${crypto.randomUUID()}.cjs`;
  // The worker's real platform shell runs this command. Keep shell syntax out
  // of the probe while requiring it to recover the secret from encrypted argv.
  await writeFile(
    path.join(directory, program),
    "require('node:fs').appendFileSync('terminal-proof.jsonl',JSON.stringify({token:process.argv[2],pid:process.pid})+'\\n');setInterval(()=>{},1000);\n",
  );
  const command = `node ${program} ${secret}`;
  const requests = [];
  const observe = (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname.includes("/terminals") ||
      pathname.endsWith("/encryption/refresh")
    )
      requests.push({ pathname, body: request.postData() });
  };
  page.on("request", observe);
  let observations;
  try {
    await eventually(
      () => page.evaluate(() => window.folderWorkers.getWorkers()),
      (workers) =>
        assert.equal(
          workers.find((w) => w.workerId === workerId)?.online,
          true,
        ),
    );
    const worktreeId = await page.evaluate(async (projectId) => {
      window.terminalApi = await import("/src/lib/api/terminals.ts");
      const { post } = await import("/src/lib/api-client.ts");
      return (
        await post(
          `/api/projects/${encodeURIComponent(projectId)}/placement/resolve`,
          { surfaceKind: "terminal" },
        )
      ).placement.worktreeId;
    }, projectId);
    const title = "Private encrypted PTY 🌿";
    const created = await page.evaluate(
      async ({ projectId, worktreeId, title }) =>
        window.terminalApi.createTerminal(projectId, title, worktreeId),
      { projectId, worktreeId, title },
    );
    assert.equal(created.title, title);
    assert.equal(created.worktreeId, worktreeId);
    assert.equal(created.service.enabled, false);
    const renamed = await page.evaluate(
      async ({ id, title }) => window.terminalApi.renameTerminal(id, title),
      { id: created.id, title: title + " renamed" },
    );
    assert.equal(renamed.title, title + " renamed");
    await page.evaluate(async (workerId) => {
      const { ensureSurfacePrivateStateWorkerEncryption } =
        await import("/src/lib/surface-private-state-worker-encryption.ts");
      const worker = (await window.folderWorkers.getWorkers()).find(
        (w) => w.workerId === workerId,
      );
      await ensureSurfacePrivateStateWorkerEncryption({ worker });
    }, workerId);
    result.steps.push(
      "existing browser creates and renames an opaque terminal and authorizes real surface-private-state grants",
    );
    const enabled = await page.evaluate(
      async ({ projectId, id, command }) => {
        const terminal = (
          await window.terminalApi.getTerminals(projectId)
        ).find((t) => t.id === id);
        return window.terminalApi.updateTerminalService(terminal, {
          enabled: true,
          command,
        });
      },
      { projectId, id: created.id, command },
    );
    assert.equal(enabled.status, "running");
    assert.equal(enabled.service.command, command);
    const read = async () => {
      try {
        return (await readFile(proof, "utf8"))
          .trim()
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    };
    let rows = await eventually(read, (rows) => {
      assert.equal(rows.length, 1);
      assert.equal(rows[0].token, secret);
      assert.ok(rows[0].pid > 0);
    });
    const initialPid = rows[0].pid;
    process.kill(initialPid, 0);
    result.steps.push(
      "full worker decrypts the service state and runs a real persistent PTY process in the newly created managed folder",
    );
    await page.evaluate(
      (id) => window.terminalApi.restartTerminalService(id),
      created.id,
    );
    rows = await eventually(read, (rows) => {
      assert.equal(rows.length, 2);
      assert.equal(rows[1].token, secret);
      assert.notEqual(rows[1].pid, initialPid);
    });
    await eventually(
      () => {
        try {
          process.kill(initialPid, 0);
          return true;
        } catch (error) {
          if (error.code === "ESRCH") return false;
          throw error;
        }
      },
      (alive) =>
        assert.equal(
          alive,
          false,
          "service restart terminates its previous process",
        ),
    );
    const restartedPid = rows[1].pid;
    await stopWorker();
    await eventually(
      () => {
        try {
          process.kill(restartedPid, 0);
          return true;
        } catch (error) {
          if (error.code === "ESRCH") return false;
          throw error;
        }
      },
      (alive) =>
        assert.equal(
          alive,
          false,
          "worker shutdown kills its terminal service",
        ),
    );
    await eventually(
      () => page.evaluate(() => window.folderWorkers.getWorkers()),
      (workers) =>
        assert.equal(
          workers.find((w) => w.workerId === workerId)?.online,
          false,
        ),
    );
    const offline = await page.evaluate(async (id) => {
      try {
        await window.terminalApi.restartTerminalService(id);
        return null;
      } catch (error) {
        return error.message;
      }
    }, created.id);
    assert.match(offline, /Project worker is offline/u);
    result.steps.push(
      "service restart creates a new real process; worker shutdown drains it and offline restart is rejected",
    );
    await startWorker();
    rows = await eventually(read, (rows) => {
      assert.equal(rows.length, 3);
      assert.equal(rows[2].token, secret);
    });
    const reconnectedPid = rows[2].pid;
    await eventually(
      () =>
        page.evaluate(
          (projectId) => window.terminalApi.getTerminals(projectId),
          projectId,
        ),
      (terminals) =>
        assert.equal(
          terminals.find((t) => t.id === created.id).status,
          "running",
        ),
    );
    if (workerLinks)
      observations = await actualWorkerObservations({
        page,
        workerId,
        result,
        route: workerLinkRoute,
      });
    const disabled = await page.evaluate(
      async ({ projectId, id, command }) => {
        const terminal = (
          await window.terminalApi.getTerminals(projectId)
        ).find((t) => t.id === id);
        return window.terminalApi.updateTerminalService(terminal, {
          enabled: false,
          command,
        });
      },
      { projectId, id: created.id, command },
    );
    assert.equal(disabled.status, "idle");
    assert.equal(disabled.service.enabled, false);
    if (observations) {
      await observations.expectTerminalExit(created.id);
      await observations.close();
    }
    await eventually(
      () => {
        try {
          process.kill(reconnectedPid, 0);
          return true;
        } catch (error) {
          if (error.code === "ESRCH") return false;
          throw error;
        }
      },
      (alive) =>
        assert.equal(alive, false, "disabling service stops its process"),
    );
    result.steps.push(
      "reconnect recreates the encrypted persisted service and disabling it stops the real process",
    );
    const publicBodies = JSON.stringify(requests);
    for (const privateValue of [title, secret, command, directory])
      assert.equal(
        publicBodies.includes(privateValue),
        false,
        "terminal request bodies retain endpoint opacity",
      );
    assert.ok(
      requests.some(
        (r) =>
          r.pathname.endsWith("/encryption/refresh") &&
          JSON.parse(r.body).component === "surface-private-state",
      ),
    );
    result.terminalService = {
      managedFolder: true,
      requests,
      processes: rows.map((r) => ({
        pid: r.pid,
        tokenMatched: r.token === secret,
      })),
      restarted: true,
      reconnected: true,
      disabled: true,
    };
    if (workerLinks)
      await actualWorkerTerminalLink({
        page,
        projectId,
        worktreeId,
        workerId,
        directory,
        result,
        route: workerLinkRoute,
      });
    if (workerLinks)
      await actualWorkerTerminalRelay({
        page,
        projectId,
        worktreeId,
        directory,
        result,
      });
    if (directBrokerBinary)
      await actualWorkerTerminalDirect({
        page,
        projectId,
        worktreeId,
        directory,
        result,
        binary: directBrokerBinary,
      });
  } finally {
    page.off("request", observe);
    await observations?.close();
    await stopWorker();
  }
}

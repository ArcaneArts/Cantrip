// Full production worker + real servers + browser encryption + actual Codex.
// Only the public model HTTP boundary is controlled. Every storage directory
// and every process terminated by this fixture belongs to this run.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  glob,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { buildRustServer, buildWorkerCli, repositoryRoot } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { eventually, launchActualWorker } from "./full-worker.mjs";
import { taskModelProvider } from "./task-model-provider.mjs";
import { killOwnedWorkerTree } from "./owned-worker-tree.mjs";
import { openSuspensionTerminal } from "./suspension-terminal-browser.mjs";
import {
  coldSuspensionStop,
  damageColdStopCheckpoint,
} from "./cold-suspension-stop.mjs";
import {
  openMountedSuspensionChat,
  clickMountedSuspensionResume,
  clickMountedSuspensionPause,
} from "./mounted-suspension-browser.mjs";
import { verifyBuiltRuntime } from "../cantrip-codex/verify-built-runtime.mjs";
import {
  enrollSuspensionBrowser,
  prepareSuspensionChat,
  suspensionChat,
  steerSuspensionChat,
} from "./durable-suspension-browser.mjs";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-production-suspension-"),
);
process.env.PGLITE_RUNTIME_DIR = path.join(root, "native-runtime");
const reportPath = option("--report") ?? root + "-report.json";
const kinds = option("--server") ? [option("--server")] : ["node", "rust"];
const report = {
  suite: "production-durable-suspension",
  root,
  passed: false,
  runtimes: [],
};
const nativeBinary = process.env.CANTRIP_CODEX_BIN;
let browser, vite, failure;

function modelFunctions(tools, namespace) {
  return (tools ?? []).flatMap((tool) =>
    tool.type === "namespace"
      ? modelFunctions(tool.tools, tool.name)
      : tool.type === "function"
        ? [{ name: tool.name, namespace }]
        : [],
  );
}

async function flow(kind, executable, cliBinary) {
  const result = { kind, kills: [], stages: [] };
  report.runtimes.push(result);
  const context = await browser.newContext();
  const page = await context.newPage();
  result.httpErrors = [];
  page.on("response", async (response) => {
    if (
      response.status() >= 400 &&
      new URL(response.url()).pathname.startsWith("/api/")
    )
      result.httpErrors.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
        body: await response.text().catch(() => ""),
      });
  });
  const model = await taskModelProvider();
  const inferences = () =>
    model.requests.filter(
      (request) =>
        request.method === "POST" && request.path.endsWith("/responses"),
    ).length;
  const directory = path.join(root, kind, "project");
  const workerData = path.join(root, kind, "worker");
  const home = path.join(root, kind, "home");
  await Promise.all([
    mkdir(directory, { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);
  const workerId = "durable-production-worker";
  const fixture = new HttpFixture({
    kind,
    executable,
    root,
    name: "durable-server",
    databaseMode: "pglite",
    providerAuthDrain: true,
    environment: {
      CANTRIP_AUTH_MODE: "accounts",
      CANTRIP_APP_ORIGINS: new URL(vite.resolvedUrls.local[0]).origin,
    },
  });
  let worker, terminal, terminalId;
  const launch = async (enrollmentCode) => {
    worker = launchActualWorker(fixture, workerData, {
      cliBinary,
      enrollmentCode,
      workerId,
      homeDirectory: home,
      isolatedProcessGroup: true,
    });
    await worker.ready();
  };
  try {
    await fixture.start();
    await page.goto(
      vite.resolvedUrls.local[0] + "__durable_suspension_fixture",
    );
    const enrollment = await enrollSuspensionBrowser(
      page,
      fixture.server.origin,
      workerId,
      "isolated durable suspension password",
    );
    await launch(enrollment.code);
    const { chat, projectId, configuration } = await prepareSuspensionChat(
      page,
      workerId,
      directory,
      model,
    );
    result.chatId = chat.id;
    await eventually(
      () =>
        page.evaluate(
          async (id) =>
            (
              await (
                await import("/src/lib/api-client.ts")
              ).request("/api/chats/" + id + "/preparation")
            ).preparation,
          chat.id,
        ),
      (preparation) =>
        assert.equal(preparation?.phase, "ready", JSON.stringify(preparation)),
      60000,
    );
    const tool = model.reply({ text: "DURABLE_TOOL_REQUEST", hold: true });
    let boundary = model.reply({ text: "DURABLE_BOUNDARY_ONE", hold: true });
    const prompt = "DURABLE_ORIGINAL_PROMPT";
    if (process.argv.includes("--terminal-origin")) {
      terminal = await openSuspensionTerminal(page, chat.id, workerId);
      terminalId = terminal.id;
      const before = inferences();
      await terminal.input(prompt);
      await eventually(terminal.read, (state) =>
        assert.ok(state.text.includes(prompt)),
      );
      assert.equal(
        inferences(),
        before,
        "Opening and editing a native terminal draft do not start inference",
      );
      await terminal.input("\r");
      result.terminalOrigin = true;
    } else {
      const admitted = await page.evaluate(
        async ({ id, prompt, configuration }) =>
          (await import("/src/lib/api/chats.ts")).startTurn(
            id,
            prompt,
            configuration,
          ),
        { id: chat.id, prompt, configuration },
      );
      assert.equal(admitted.status, "queued");
    }
    await eventually(
      () => tool.entered,
      (value) => assert.equal(value, true),
    );
    const functions = modelFunctions(tool.request.input.tools);
    result.tools = functions;
    const command = functions.find(
      (t) => t.name === "exec_command" || t.name.endsWith("__exec_command"),
    );
    assert.ok(
      command,
      "The actual native model request advertises exec_command: " +
        JSON.stringify(functions),
    );
    tool.calls = [
      {
        ...command,
        arguments: {
          cmd: "printf 'DURABLE_TOOL_RESULT\\n' | tee -a durable-cold-marker",
          yield_time_ms: 1000,
          max_output_tokens: 1000,
        },
      },
    ];
    tool.release();
    await eventually(
      () => boundary.entered,
      (value) => assert.equal(value, true),
    );
    assert.equal(
      await readFile(path.join(directory, "durable-cold-marker"), "utf8"),
      "DURABLE_TOOL_RESULT\n",
    );
    assert.ok(
      JSON.stringify(boundary.request.input.input).includes(
        "DURABLE_TOOL_RESULT",
      ),
    );
    const identity = () => suspensionChat(page, projectId, chat.id);
    const messages = () =>
      page.evaluate(
        async (id) => (await import("/src/lib/api/chats.ts")).getMessages(id),
        chat.id,
      );
    if (process.argv.includes("--mounted-ui"))
      await openMountedSuspensionChat(page, vite.resolvedUrls.local[0], false);
    if (terminalId && process.argv.includes("--mounted-ui")) {
      terminal.dispose();
      terminal = await openSuspensionTerminal(
        page,
        chat.id,
        workerId,
        terminalId,
      );
    }
    let active;
    for (let round = 1; round <= 2; round++) {
      const steering = "DURABLE_ACCEPTED_PENDING_" + round;
      const pausing = process.argv.includes("--mounted-ui")
        ? clickMountedSuspensionPause(page, chat.id)
        : page.evaluate(
            async (id) =>
              (await import("/src/lib/api/chats.ts")).setChatPaused(id, true),
            chat.id,
          );
      void pausing.catch(() => {});
      await eventually(identity, (value) =>
        assert.equal(value.nativeSuspension.phase, "pausing"),
      );
      if (process.argv.includes("--mounted-ui")) {
        await page
          .getByRole("status")
          .filter({ hasText: /^Pausing at the next safe boundary/ })
          .waitFor({ state: "visible" });
        assert.equal(
          await page.getByRole("button", { name: "Pausing" }).isDisabled(),
          true,
        );
        assert.equal(
          await page
            .getByRole("button", { name: "Stop current operation" })
            .isEnabled(),
          true,
        );
        const statuses = await page.getByRole("status").allTextContents();
        assert.equal(
          statuses.some((status) => status.trim().startsWith("Paused")),
          false,
          "A pending native checkpoint is not confirmed Paused",
        );
        (result.pendingUi ??= []).push({ round, statuses });
      }
      assert.equal(
        (await steerSuspensionChat(page, chat.id, configuration, steering))
          .steered,
        true,
      );
      boundary.release();
      assert.equal((await pausing).paused, true);
      const paused = await identity();
      assert.equal(paused.nativeSuspension.phase, "paused");
      assert.equal(paused.nativeSuspension.resumable, true);
      console.error(kind, "durable pause acknowledged", round);
      active ??= paused.nativeSuspension.active;
      assert.deepEqual(paused.nativeSuspension.active, active);
      const killed = worker;
      worker = undefined;
      const terminated = await killOwnedWorkerTree(killed.child);
      const owned = terminated.processes;
      assert.ok(
        owned.some((p) => p.command.includes("codex")),
        "The killed worker tree includes the actual native runtime",
      );
      result.kills.push({
        round,
        processes: owned,
        groups: terminated.groups,
        native: active,
        signal: killed.child.signalCode,
      });
      console.error(kind, "worker tree terminated", round, owned.length);
      result.workerDiagnostics = killed.diagnostics();
      if (
        process.argv.includes("--cold-stop") &&
        option("--checkpoint-damage")
      ) {
        result.checkpointDamage = option("--checkpoint-damage");
        await damageColdStopCheckpoint(
          workerData,
          active,
          result.checkpointDamage,
        );
      }
      const count = inferences();
      await launch();
      const reopened = await identity();
      assert.equal(reopened.automationPaused, true);
      assert.equal(reopened.nativeSuspension.phase, "paused");
      assert.deepEqual(reopened.nativeSuspension.active, active);
      await messages();
      if (process.argv.includes("--mounted-ui")) {
        const opened = await openMountedSuspensionChat(
          page,
          vite.resolvedUrls.local[0],
        );
        (result.mountedUi ??= []).push({ round, ...opened });
      }
      if (terminalId) {
        terminal.dispose();
        terminal = await openSuspensionTerminal(
          page,
          chat.id,
          workerId,
          terminalId,
        );
        let state;
        await eventually(
          async () => (state = await terminal.read()),
          (value) => {
            assert.ok(value.text.includes(prompt), value.text);
            assert.ok(value.text.includes("DURABLE_TOOL_RESULT"), value.text);
          },
        );
        (result.terminalReattachments ??= []).push({ round, text: state.text });
      }
      await delay(300);
      assert.equal(
        inferences(),
        count,
        "Worker startup and chat reads do not start inference",
      );
      assert.equal(
        await readFile(path.join(directory, "durable-cold-marker"), "utf8"),
        "DURABLE_TOOL_RESULT\n",
      );
      if (process.argv.includes("--cold-stop")) {
        result.stopped = await coldSuspensionStop({
          page,
          chatId: chat.id,
          identity,
          workerData,
          active,
          inferences,
          mounted: process.argv.includes("--mounted-ui"),
        });
        return;
      }
      const next = model.reply(
        round === 1
          ? { text: "DURABLE_BOUNDARY_TWO", hold: true }
          : { text: "DURABLE_RECOVERED_FINAL" },
      );
      const resumed = process.argv.includes("--mounted-ui")
        ? await clickMountedSuspensionResume(page, chat.id)
        : await page.evaluate(async (id) => {
            const { setChatPaused } = await import("/src/lib/api/chats.ts");
            return Promise.all([
              setChatPaused(id, false),
              setChatPaused(id, false),
            ]);
          }, chat.id);
      assert.ok(resumed.every((value) => value.paused === false));
      console.error(kind, "explicit Resume acknowledged", round);
      await eventually(
        () => next.entered,
        (value) => assert.equal(value, true),
      );
      const restoredInput = JSON.stringify(next.request.input.input);
      assert.ok(restoredInput.includes(prompt));
      assert.ok(restoredInput.includes("DURABLE_TOOL_RESULT"));
      assert.ok(restoredInput.includes(steering));
      assert.ok(restoredInput.includes(await realpath(directory)));
      assert.equal(next.request.input.model, tool.request.input.model);
      assert.deepEqual(
        next.request.input.reasoning,
        tool.request.input.reasoning,
      );
      assert.equal(
        next.request.input.input.filter(
          (item) =>
            item.type === "function_call_output" &&
            item.call_id === "task-fixture-response-0-call-0",
        ).length,
        1,
        "The completed command result occurs exactly once in restored context",
      );
      assert.deepEqual((await identity()).nativeSuspension.active, active);
      result.stages.push({
        round,
        providerRequests: inferences(),
        native: active,
      });
      boundary = next;
    }
    const completed = await eventually(identity, (value) => {
      assert.equal(value.status, "idle");
      assert.equal(value.nativeSuspension.phase, "completed");
      assert.equal(value.nativeSuspension.resumable, false);
    });
    const finalMessages = await eventually(messages, (value) =>
      assert.ok(JSON.stringify(value).includes("DURABLE_RECOVERED_FINAL")),
    );
    const textItems = finalMessages
      .flatMap((message) => message.content)
      .filter((item) => item.type === "text");
    if (process.argv.includes("--mounted-ui")) {
      await page
        .getByText("DURABLE_RECOVERED_FINAL", { exact: true })
        .first()
        .waitFor({ state: "visible" });
      result.mountedFinalVisible = true;
    }
    if (terminal) {
      await eventually(terminal.read, (state) =>
        assert.ok(state.text.includes("DURABLE_RECOVERED_FINAL")),
      );
      result.terminalFinalVisible = true;
    }
    assert.equal(textItems.filter((item) => item.text === prompt).length, 1);
    const final = textItems.find(
      (item) => item.text === "DURABLE_RECOVERED_FINAL",
    );
    assert.equal(final.correlation.threadId, active.threadId);
    assert.equal(final.correlation.turnId, active.turnId);
    const rollouts = [];
    for await (const relative of glob("**/rollout-*.jsonl", {
      cwd: workerData,
    }))
      if (path.basename(relative).includes(active.threadId))
        rollouts.push(path.join(workerData, relative));
    assert.equal(
      rollouts.length,
      1,
      "Cold restoration continues the original persisted rollout",
    );
    const history = (await readFile(rollouts[0], "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const events = history
      .filter((row) => row.type === "event_msg")
      .map((row) => row.payload);
    assert.equal(
      events.filter((event) => event.type === "task_started").length,
      1,
    );
    assert.equal(
      events.filter((event) => event.type === "task_complete").length,
      1,
    );
    assert.equal(
      events.filter((event) => event.type === "turn_aborted").length,
      0,
    );
    const items = history
      .filter((row) => row.type === "response_item")
      .map((row) => row.payload);
    for (const text of [
      prompt,
      "DURABLE_ACCEPTED_PENDING_1",
      "DURABLE_ACCEPTED_PENDING_2",
    ])
      assert.equal(
        items.filter(
          (item) =>
            item.type === "message" &&
            item.role === "user" &&
            item.content.some((content) => content.text === text),
        ).length,
        1,
      );
    assert.equal(
      items.filter(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === "task-fixture-response-0-call-0",
      ).length,
      1,
    );
    assert.equal(
      await readFile(path.join(directory, "durable-cold-marker"), "utf8"),
      "DURABLE_TOOL_RESULT\n",
    );
    assert.deepEqual(model.failures, []);
    result.completed = {
      native: active,
      phase: completed.nativeSuspension.phase,
      requests: inferences(),
      nativeTurnStarts: 1,
      nativeTurnCompletions: 1,
      commandResults: 1,
    };
  } catch (error) {
    if (process.argv.includes("--mounted-ui"))
      result.uiText = await page
        .locator("body")
        .innerText()
        .catch(() => "");
    if (process.argv.includes("--mounted-ui"))
      result.uiSnapshot = await page
        .locator("body")
        .ariaSnapshot()
        .catch(() => "");
    result.error = error.stack;
    throw error;
  } finally {
    terminal?.dispose();
    if (worker) {
      result.workerDiagnostics = worker.diagnostics();
      await killOwnedWorkerTree(worker.child);
    }
    result.providerFailures = model.failures;
    result.providerRequests = model.requests.map((request) => ({
      method: request.method,
      path: request.path,
      completed: request.completed,
    }));
    await model.close();
    await page.evaluate(() => window.suspensionLive?.stop()).catch(() => {});
    await context.close();
    await fixture.close().catch((error) => {
      result.cleanupError = error.stack;
      if (!result.error) throw error;
    });
  }
}

try {
  await verifyBuiltRuntime(path.dirname(nativeBinary));
  const appRoot = path.join(repositoryRoot, "cantrip_app");
  const requireApp = createRequire(path.join(appRoot, "package.json"));
  const { createServer } = await import(
    pathToFileURL(requireApp.resolve("vite")).href
  );
  vite = await createServer({
    root: appRoot,
    configFile: path.join(appRoot, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [
      {
        name: "durable-suspension-fixture",
        configureServer(server) {
          server.middlewares.use(
            "/__durable_suspension_fixture",
            async (_request, response, next) => {
              try {
                const html = await server.transformIndexHtml(
                  "/__durable_suspension_fixture",
                  "<!doctype html><html><body>Durable suspension acceptance</body></html>",
                );
                response.setHeader("content-type", "text/html");
                response.end(html);
              } catch (error) {
                next(error);
              }
            },
          );
        },
      },
    ],
  });
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  const cliBinary = await buildWorkerCli();
  const executable = kinds.includes("rust")
    ? await buildRustServer()
    : undefined;
  for (const kind of kinds) await flow(kind, executable, cliBinary);
  report.passed = true;
} catch (error) {
  failure = error;
  report.error = error.stack;
} finally {
  await browser?.close();
  await vite?.close();
  if (report.passed && !process.argv.includes("--retain")) {
    try {
      await rm(root, { recursive: true });
      report.cleaned = true;
    } catch (error) {
      report.cleanupError = error.stack;
      report.passed = false;
      failure ??= error;
    }
  }
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    suite: report.suite,
    passed: report.passed,
    reportPath,
    error: report.error,
  }),
);
if (failure) process.exitCode = 1;

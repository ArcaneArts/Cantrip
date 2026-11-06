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
import { prestartPreparationFixture } from "./prestart-preparation-fixture.mjs";
import { qualifyTaskSuspension } from "./suspension-task-browser.mjs";
import { killOwnedWorkerTree } from "./owned-worker-tree.mjs";
import { openSuspensionTerminal } from "./suspension-terminal-browser.mjs";
import {
  completedSessionCommand,
  retainedSuspensionSession,
  completedSuspensionSession,
  completedSessionPoll,
  observeCompletedSessionPoll,
  assertCompletedSessionResult,
} from "./suspension-terminal-resource.mjs";
import { refuseActiveSuspensionSession } from "./suspension-resource-refusal.mjs";
import {
  startSuspensionCapacityBlocker,
  pauseWaitingSuspension,
} from "./suspension-capacity-browser.mjs";
import {
  updatePausedSuspensionSettings,
  readSuspensionSettings,
} from "./suspension-settings-browser.mjs";
import { verifyPendingSuspensionStop } from "./pending-suspension-stop.mjs";
import {
  answerSuspensionInteraction,
  qualifySuspensionPlanRoutes,
  readHeldSuspensionPlan,
} from "./suspension-interaction-browser.mjs";
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
  const preparation = process.argv.includes("--prestart-preparation")
    ? await prestartPreparationFixture(directory)
    : null;
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
    const { chat, task, projectId, providerId, configuration } =
      await prepareSuspensionChat(page, workerId, directory, model, {
        taskOrigin: process.argv.includes("--task-origin"),
        ...(process.argv.includes("--capacity-waiting") ||
        process.argv.includes("--task-stop-restoring")
          ? { maxConcurrentInference: 1 }
          : {}),
      });
    result.chatId = chat.id;
    if (!task)
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
          assert.equal(
            preparation?.phase,
            "ready",
            JSON.stringify(preparation),
          ),
        60000,
      );
    if (process.argv.includes("--pending-question")) {
      result.planRoutes = await qualifySuspensionPlanRoutes(page, chat.id);
      await page.evaluate(
        async (id) =>
          (await import("/src/lib/api/chats.ts")).updateChatPlan(id, {
            mode: "plan",
          }),
        chat.id,
      );
    }
    const capacityBlocker = process.argv.includes("--capacity-waiting")
      ? await startSuspensionCapacityBlocker({
          page,
          model,
          projectId,
          providerId,
          workerId,
          configuration,
        })
      : null;
    const tool = model.reply({ text: "DURABLE_TOOL_REQUEST", hold: true });
    let boundary = model.reply({ text: "DURABLE_BOUNDARY_ONE", hold: true });
    const prompt = "DURABLE_ORIGINAL_PROMPT";
    if (preparation && process.argv.includes("--live-preparation"))
      await openMountedSuspensionChat(page, vite.resolvedUrls.local[0], null);
    let acceptedPrompt;
    if (task) {
      result.taskAdmission = await page.evaluate(
        async ({ chatId, rowVersion }) =>
          (await import("/src/lib/api/tasks.ts")).startTaskDirectly(chatId, {
            rowVersion,
            operationId: crypto.randomUUID(),
          }),
        { chatId: chat.id, rowVersion: task.rowVersion },
      );
    } else if (process.argv.includes("--terminal-origin")) {
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
      await preparation?.arm();
      await terminal.input("\r");
      result.terminalOrigin = true;
    } else {
      await preparation?.arm();
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
      acceptedPrompt = {
        id: admitted.prompt.id,
        revision: admitted.prompt.revision,
        text: admitted.prompt.text,
      };
    }
    if (capacityBlocker || preparation) {
      if (preparation) result.prestartPreparation = await preparation.entered();
      result.capacityWaiting = await pauseWaitingSuspension({
        page,
        chatId: chat.id,
        workerId,
        workerData,
        model,
        blocker: capacityBlocker,
        expectedState: preparation ? "granted" : "waiting",
      });
      if (!acceptedPrompt) {
        const retained = await page.evaluate(
          async ({ chatId, prompt }) => {
            const matches = (
              await (
                await import("/src/lib/api/queue.ts")
              ).getQueuedPrompts(chatId)
            ).filter((item) => item.text === prompt);
            if (matches.length !== 1)
              throw new Error(
                "The accepted terminal input must have one canonical queue item.",
              );
            return matches[0];
          },
          { chatId: chat.id, prompt },
        );
        acceptedPrompt = {
          id: retained.id,
          revision: retained.revision,
          text: retained.text,
        };
      }
      result.capacityWaiting.acceptedPrompt = acceptedPrompt;
      const count = inferences();
      if (preparation && process.argv.includes("--live-preparation")) {
        await preparation.release();
        await preparation.released(result.prestartPreparation);
        assert.equal(
          inferences(),
          count,
          "Finishing preparation while paused cannot forward the native input",
        );
        result.capacityWaiting.livePreparationReleased = true;
      } else {
        const killed = worker;
        worker = undefined;
        terminal?.dispose();
        terminal = undefined;
        const terminated = await killOwnedWorkerTree(killed.child, {
          executableRoots: [workerData],
        });
        result.kills.push({
          round: preparation ? "prestart-preparation" : "capacity-waiting",
          ...terminated,
        });
        await preparation?.release();
        await launch();
        const reopened = await suspensionChat(page, projectId, chat.id);
        assert.equal(reopened.automationPaused, true);
        assert.equal(reopened.nativeSuspension?.resumable ?? false, false);
        assert.equal(reopened.nativeSuspension?.active ?? null, null);
        await openMountedSuspensionChat(page, vite.resolvedUrls.local[0], null);
        if (acceptedPrompt) {
          const retained = await eventually(
            () =>
              page.evaluate(
                async ({ chatId, promptId }) =>
                  (
                    await (
                      await import("/src/lib/api/queue.ts")
                    ).getQueuedPrompts(chatId)
                  ).find((item) => item.id === promptId),
                { chatId: chat.id, promptId: acceptedPrompt.id },
              ),
            (item) => assert.ok(item),
          );
          assert.deepEqual(
            {
              id: retained.id,
              revision: retained.revision,
              text: retained.text,
            },
            acceptedPrompt,
          );
          result.capacityWaiting.promptReopened = true;
        }
        if (terminalId)
          terminal = await openSuspensionTerminal(
            page,
            chat.id,
            workerId,
            terminalId,
          );
      }
      assert.equal(
        inferences(),
        count,
        "Reopening a held request without a native turn starts no inference",
      );
      const resumed = await clickMountedSuspensionResume(page, chat.id);
      assert.ok(resumed.every((value) => value.paused === false));
      result.capacityWaiting.resumed = true;
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
    if (
      process.argv.includes("--completed-session") ||
      process.argv.includes("--active-session")
    )
      tool.calls[0].arguments = completedSessionCommand();
    if (process.argv.includes("--pending-approval")) {
      tool.calls[0].arguments.sandbox_permissions = "require_escalated";
      tool.calls[0].arguments.justification =
        "Controlled suspension acceptance command in the disposable project.";
    }
    if (process.argv.includes("--pending-question")) {
      const question = functions.find(
        (entry) => entry.name === "request_user_input",
      );
      assert.ok(question);
      tool.calls.push({
        ...question,
        arguments: {
          isBlocking: true,
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "DURABLE_QUESTION",
              options: [
                {
                  label: "DURABLE_ANSWER",
                  description: "Retain this accepted answer.",
                },
                { label: "Another", description: "Unused fixture choice." },
              ],
            },
          ],
        },
      });
    }
    tool.release();
    if (
      process.argv.includes("--pending-question") ||
      process.argv.includes("--pending-approval")
    ) {
      const interaction = await answerSuspensionInteraction({
        page,
        chatId: chat.id,
        projectId,
        origin: vite.resolvedUrls.local[0],
        mounted: process.argv.includes("--mounted-ui"),
        inferences,
        kind: process.argv.includes("--pending-question")
          ? "userInput"
          : "commandExecution",
        stopPending: process.argv.includes("--stop-pending-interaction"),
      });
      if (interaction.stopped) {
        result.pendingStop = interaction;
        const killed = worker;
        worker = undefined;
        terminal?.dispose();
        terminal = undefined;
        const terminated = await killOwnedWorkerTree(killed.child, {
          executableRoots: [workerData],
        });
        result.kills.push({
          round: "stopped",
          ...terminated,
          native: interaction.native,
        });
        await launch();
        if (process.argv.includes("--mounted-ui"))
          await openMountedSuspensionChat(
            page,
            vite.resolvedUrls.local[0],
            null,
          );
        if (terminalId)
          terminal = await openSuspensionTerminal(
            page,
            chat.id,
            workerId,
            terminalId,
          );
        if (terminal)
          await eventually(terminal.read, (value) =>
            assert.ok(value.text.includes(prompt), value.text),
          );
        if (process.argv.includes("--mounted-ui")) {
          await page
            .getByText(prompt, { exact: true })
            .first()
            .waitFor({ state: "visible" });
          assert.equal(
            await page
              .getByRole("button", { name: "Resume turn", exact: true })
              .count(),
            0,
          );
          assert.equal(
            await page
              .getByRole("status")
              .filter({ hasText: /^Paused$/ })
              .count(),
            0,
          );
          assert.equal(
            await page
              .getByRole("button", { name: "Allow once", exact: true })
              .count(),
            0,
          );
          assert.equal(
            await page.getByRole("group", { name: /DURABLE_QUESTION/ }).count(),
            0,
          );
        }
        result.pendingStop = await verifyPendingSuspensionStop({
          page,
          chatId: chat.id,
          identity: () => suspensionChat(page, projectId, chat.id),
          workerData,
          directory,
          interaction,
          inferences,
        });
        assert.deepEqual(model.failures, []);
        return;
      }
      if (interaction.kind === "userInput") result.question = interaction;
      else result.approval = interaction;
    }
    await eventually(
      () => boundary.entered,
      (value) => assert.equal(value, true),
    );
    if (task) {
      result.taskSuspension = await qualifyTaskSuspension({
        completeOnly: process.argv.includes("--task-complete"),
        pauseOnly: process.argv.includes("--task-pause-only"),
        livePause: process.argv.includes("--task-live-pause"),
        rounds:
          option("--task-cold-rounds") === undefined
            ? 1
            : Number(option("--task-cold-rounds")),
        duplicateResume: process.argv.includes("--task-duplicate-resume"),
        restoreDamage: option("--task-restore-damage"),
        stopOnly: process.argv.includes("--task-cold-stop"),
        stopDamage: option("--task-stop-damage"),
        stopPendingPause: process.argv.includes("--task-stop-pending-pause"),
        stopRunning: process.argv.includes("--task-running-stop"),
        stopRestoring: process.argv.includes("--task-stop-restoring"),
        workerId,
        startBlocker: () =>
          startSuspensionCapacityBlocker({
            page,
            model,
            projectId,
            providerId,
            workerId,
            configuration,
          }),
        page,
        projectId,
        chatId: chat.id,
        directory,
        workerData,
        model,
        boundary,
        command,
        inferences,
        result,
        async restart(native, round) {
          const killed = worker;
          worker = undefined;
          const terminated = await killOwnedWorkerTree(killed.child, {
            executableRoots: [workerData],
          });
          result.kills.push({
            round: `task-paused-${round}`,
            ...terminated,
            native,
          });
          await launch();
        },
      });
      return;
    }
    if (process.argv.includes("--active-session")) {
      result.session = retainedSuspensionSession(boundary);
      boundary = await refuseActiveSuspensionSession({
        page,
        chatId: chat.id,
        projectId,
        origin: vite.resolvedUrls.local[0],
        workerData,
        directory,
        session: result.session,
        boundary,
        model,
        inferences,
        configuration,
        stopActive: process.argv.includes("--stop-active-session"),
      });
      if (result.session.refusal.stopped) {
        result.stopped = result.session.refusal.stopped;
        const killed = worker;
        worker = undefined;
        terminal?.dispose();
        terminal = undefined;
        const terminated = await killOwnedWorkerTree(killed.child, {
          executableRoots: [workerData],
        });
        result.kills.push({
          round: "stopped-resource",
          ...terminated,
          native: result.stopped.native,
        });
        await launch();
        if (process.argv.includes("--mounted-ui"))
          await openMountedSuspensionChat(
            page,
            vite.resolvedUrls.local[0],
            null,
          );
        if (terminalId) {
          terminal = await openSuspensionTerminal(
            page,
            chat.id,
            workerId,
            terminalId,
          );
          await eventually(terminal.read, (value) =>
            assert.ok(value.text.includes(prompt), value.text),
          );
        }
        const stopped = await suspensionChat(page, projectId, chat.id);
        assert.equal(stopped.nativeSuspension.phase, "stopped");
        assert.equal(stopped.nativeSuspension.resumable, false);
        assert.equal(inferences(), result.stopped.requests);
        assert.deepEqual(model.failures, []);
        return;
      }
    } else if (process.argv.includes("--completed-session"))
      result.session = await completedSuspensionSession(boundary, directory);
    if (result.question)
      result.question.activeModeChange = await qualifySuspensionPlanRoutes(
        page,
        chat.id,
        true,
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
    let active, postPausePrompt;
    for (let round = 1; round <= 2; round++) {
      const steering =
        round === 2 && postPausePrompt
          ? postPausePrompt.text
          : "DURABLE_ACCEPTED_PENDING_" + round;
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
      if (round === 2 && postPausePrompt) {
        const accepted = await page.evaluate(
          async ({ id, revision }) =>
            (await import("/src/lib/api/queue.ts")).steerQueuedPrompt(
              id,
              revision,
            ),
          postPausePrompt,
        );
        assert.equal(accepted.steered, true);
        result.postPausePrompt.steered = true;
      } else
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
      if (result.question) assert.deepEqual(active, result.question.native);
      if (result.approval) assert.deepEqual(active, result.approval.native);
      let changedSettings;
      if (process.argv.includes("--post-pause-settings")) {
        const before = inferences();
        changedSettings = await updatePausedSuspensionSettings(
          page,
          chat.id,
          round === 1 ? "high" : "low",
        );
        changedSettings.confirmed = await eventually(
          () => readSuspensionSettings(page, chat.id),
          (value) => assert.equal(value?.effort, changedSettings.effort),
        );
        assert.equal(changedSettings.threadId, active.threadId);
        const held = await identity();
        assert.equal(held.nativeSuspension.phase, "paused");
        assert.equal(held.nativeSuspension.resumable, true);
        assert.deepEqual(held.nativeSuspension.active, active);
        assert.equal(
          inferences(),
          before,
          "Changing held settings starts no inference",
        );
        (result.postPauseSettings ??= []).push({ round, ...changedSettings });
      }
      if (round === 1 && process.argv.includes("--post-pause-queue")) {
        const count = inferences();
        postPausePrompt = await page.evaluate(
          async ({ id, configuration }) => {
            const accepted = await (
              await import("/src/lib/api/chats.ts")
            ).startTurn(
              id,
              "DURABLE_POST_PAUSE_QUEUED_ORIGINAL",
              configuration,
            );
            if (accepted.status !== "queued")
              throw new Error("Paused input was not queued");
            return (await import("/src/lib/api/queue.ts")).updateQueuedPrompt(
              id,
              accepted.prompt.id,
              {
                expectedItemRevision: accepted.prompt.revision,
                text: "DURABLE_POST_PAUSE_QUEUED_REVISED",
              },
            );
          },
          { id: chat.id, configuration },
        );
        const held = await identity();
        assert.equal(held.nativeSuspension.phase, "paused");
        assert.deepEqual(held.nativeSuspension.active, active);
        assert.equal(
          inferences(),
          count,
          "Accepting and revising paused input starts no inference",
        );
        result.postPausePrompt = {
          id: postPausePrompt.id,
          revision: postPausePrompt.revision,
          text: postPausePrompt.text,
        };
      }
      const killed = worker;
      worker = undefined;
      const terminated = await killOwnedWorkerTree(killed.child, {
        executableRoots: [workerData],
      });
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
      if (result.question)
        (result.offlinePlans ??= []).push(
          await readHeldSuspensionPlan(page, chat.id),
        );
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
      if (result.question)
        (result.heldPlans ??= []).push(
          await readHeldSuspensionPlan(page, chat.id),
        );
      if (round === 1 && postPausePrompt) {
        const queue = await page.evaluate(
          async (id) =>
            (await import("/src/lib/api/queue.ts")).getQueuedPrompts(id),
          chat.id,
        );
        const retained = queue.find((entry) => entry.id === postPausePrompt.id);
        assert.ok(retained);
        assert.equal(retained.revision, postPausePrompt.revision);
        assert.equal(retained.text, postPausePrompt.text);
        result.postPausePrompt.reopened = true;
      }
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
      if (changedSettings)
        result.postPauseSettings.at(-1).held = await eventually(
          () => readSuspensionSettings(page, chat.id, false),
          (value) => assert.equal(value?.effort, changedSettings.effort),
        );
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
      const polling =
        round === 1 && result.session
          ? completedSessionPoll(model, functions, result.session)
          : null;
      const next =
        polling?.next ??
        model.reply(
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
      if (round === 2 && result.session)
        assertCompletedSessionResult(next.request.input.input, result.session);
      assert.ok(restoredInput.includes(prompt));
      assert.ok(restoredInput.includes("DURABLE_TOOL_RESULT"));
      if (result.question) {
        const answers = next.request.input.input.filter(
          (item) =>
            item.type === "function_call_output" &&
            item.call_id === "task-fixture-response-0-call-1",
        );
        assert.equal(
          answers.length,
          1,
          "The accepted native question result occurs once",
        );
        assert.ok(
          JSON.stringify(answers[0].output).includes(result.question.answer),
        );
      }
      assert.ok(restoredInput.includes(steering));
      if (round === 1 && postPausePrompt) {
        assert.equal(restoredInput.includes(postPausePrompt.text), false);
      }
      if (postPausePrompt)
        assert.equal(
          restoredInput.includes("DURABLE_POST_PAUSE_QUEUED_ORIGINAL"),
          false,
        );
      assert.ok(restoredInput.includes(await realpath(directory)));
      assert.equal(next.request.input.model, tool.request.input.model);
      assert.deepEqual(
        next.request.input.reasoning,
        tool.request.input.reasoning,
      );
      if (changedSettings) {
        const settings = await eventually(
          () => readSuspensionSettings(page, chat.id),
          (value) => assert.equal(value?.effort, changedSettings.effort),
        );
        result.postPauseSettings.at(-1).restored = settings;
      }
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
      if (polling)
        await observeCompletedSessionPoll(polling.afterPoll, result.session);
      boundary = polling?.afterPoll ?? next;
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
    if (postPausePrompt) {
      assert.equal(
        textItems.filter((item) => item.text === postPausePrompt.text).length,
        1,
      );
      assert.equal(
        textItems.some(
          (item) => item.text === "DURABLE_POST_PAUSE_QUEUED_ORIGINAL",
        ),
        false,
      );
    }
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
    if (result.session) assertCompletedSessionResult(items, result.session);
    if (result.question) {
      assert.equal(
        items.filter(
          (item) =>
            item.type === "function_call_output" &&
            item.call_id === "task-fixture-response-0-call-1",
        ).length,
        1,
      );
    }
    const interaction = result.question ?? result.approval;
    if (interaction) {
      const requests = await page.evaluate(
        async (chatId) =>
          (await import("/src/lib/api/chats.ts")).getAgentInteractionRequests({
            chatId,
          }),
        chat.id,
      );
      assert.equal(requests.length, 1);
      assert.equal(requests[0].id, interaction.requestId);
      assert.equal(requests[0].status, "resolved");
    }
    for (const text of [
      prompt,
      "DURABLE_ACCEPTED_PENDING_1",
      postPausePrompt ? postPausePrompt.text : "DURABLE_ACCEPTED_PENDING_2",
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
    result.serverDiagnostics = fixture.server?.diagnostics();
    if (result.taskAdmission)
      result.taskFailureState = await page
        .evaluate(
          async (id) => (await import("/src/lib/api/tasks.ts")).getTask(id),
          result.chatId,
        )
        .catch((failure) => ({ observationError: failure.message }));
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
      await killOwnedWorkerTree(worker.child, {
        executableRoots: [workerData],
      });
    }
    await preparation?.release();
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

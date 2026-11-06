// Process-isolated worker API fixture. All native RPCs, encrypted storage and
// HPKE grants are real. This fixture does not configure server admission.
import { spawn } from "node:child_process";
import path from "node:path";
import { CodexAppServer } from "../src/codex/app-server.js";
import { discoverCodexRuntime } from "../src/codex/discovery.js";
import { createManagedSuspensionCapture } from "../src/codex/managed-native-suspension.js";
import { NativeSuspensionStore } from "../src/native-suspension-store.js";
import { resourceProtectionFixture } from "./native-resource-protection-fixture.js";

const config = JSON.parse(process.argv[2]!);
const send = (value: Record<string, unknown>) => process.send?.(value);
const encryption = await resourceProtectionFixture(
  path.join(config.data, "encryption"),
);
if (config.denyGrant) await encryption.authorize(false);
const store = new NativeSuspensionStore(
  config.data,
  () => ({
    serverId: encryption.service.serverIdentity(),
    ownerId: encryption.service.ownerId(),
    workerId: "native-resource-fixture",
  }),
  encryption.service,
);
const provider = {
  id: "provider",
  name: "Local deterministic provider",
  kind: "openai-compatible" as const,
  baseUrl: config.provider,
  apiKey: `fixture-key-${process.pid}`,
  accountId: "account",
};
const model = {
  id: "model",
  routeId: "route",
  name: "gpt-5",
  reasoningEffort: null,
};
let threadId = config.suspension?.threadId ?? "";
let turnId = config.suspension?.turnId ?? "";
let runtime: CodexAppServer;
let starts = 0;
const activities: unknown[] = [];
const source = () => ({
  chatId: "chat",
  threadId,
  contextKind: "standalone" as const,
  projectId: null,
  placementId: "scratch",
  modelRouteId: "route",
  providerAccountId: "account",
});
const finish = async (result: unknown) => {
  const history = await runtime.readNativeHistory(threadId);
  send({ type: "completed", result, starts, activities, history });
};
const failure = (error: unknown) =>
  send({
    type: "error",
    error: error instanceof Error ? error.stack : String(error),
  });
try {
  const opened = config.storageId
    ? await store.open(config.storageId, source())
    : null;
  const home = opened?.home ?? config.home;
  runtime = new CodexAppServer(
    config.binary,
    config.data,
    home,
    await discoverCodexRuntime(config.binary, home),
    undefined,
    undefined,
    undefined,
    (executable, args, options) => {
      const child = spawn(executable, args, {
        cwd: config.cwd,
        env: { ...options.env, HOME: home, CODEX_HOME: home },
        stdio: "pipe",
      });
      child.stderr.on("data", (chunk) => process.stderr.write(chunk));
      send({ type: "native-process", pid: child.pid });
      return child;
    },
    [],
    null,
    null,
    null,
    encryption.protection,
  );
  // Observe actual native notifications; do not synthesize a TurnStarted event.
  const native = runtime as unknown as { handleMessage(data: Buffer): void };
  const receive = native.handleMessage.bind(runtime);
  native.handleMessage = (data) => {
    const frame = JSON.parse(String(data));
    if (frame.method === "turn/started") {
      starts++;
      threadId = frame.params.threadId;
      turnId = frame.params.turn.id;
      send({ type: "turn", threadId, turnId });
    }
    receive(data);
  };
  if (opened) {
    if (!opened.continuation)
      throw new Error(
        "Worker bookkeeping version is unavailable for cold restoration.",
      );
    const options = {
      operationGeneration: `fresh-${process.pid}`,
      threadId,
      chatId: "chat",
      cwd: config.cwd,
      executionLaneId: `fresh-lane-${process.pid}`,
      captureProtectedDiagnostics: false,
      // These changed defaults must not overwrite the saved effective model.
      model: {
        ...model,
        name: "different-current-default",
        reasoningEffort: "high" as const,
      },
      provider,
      onActivity: (value: unknown) => activities.push(value),
    };
    const handles = await Promise.all([
      runtime.prepareRestoredNativeExecution(
        options,
        config.suspension,
        opened.continuation,
      ),
      runtime.prepareRestoredNativeExecution(
        options,
        config.suspension,
        opened.continuation,
      ),
    ]);
    if (handles[0] !== handles[1])
      throw new Error("Duplicate restoration created different observers.");
    handles[0]!.completion.then(finish, failure).catch(failure);
    const captured = runtime.captureWorkerTurnContinuation(threadId, turnId);
    send({
      type: "restored",
      starts,
      threadId,
      turnId,
      baseline: captured.baseline,
      expectedBaseline: opened.continuation.baseline,
      latestUsage: captured.latestUsage,
      expectedLatestUsage: opened.continuation.latestUsage,
      contextUsage: captured.contextUsage,
      expectedContextUsage: opened.continuation.contextUsage,
      sourceHome: opened.home,
      home,
    });
  } else {
    runtime
      .runTurn({
        chatId: "chat",
        cwd: config.cwd,
        executionLaneId: "original-lane",
        developerInstructions: null,
        prompt: "ORIGINAL_COLD_INPUT",
        history: [],
        attachments: [],
        skillNames: [],
        threadId: null,
        model,
        provider,
        captureProtectedDiagnostics: false,
        automationPaused: false,
        permissionProfileId: ":yolo",
        planMode: "default",
        mcpServers: [],
        subagentDefaults: null,
        rootKind: "git-worktree",
        worktreeMode: "agent-managed",
        worktreePolicy: "agent-managed",
        onThreadLoaded: (id) => {
          threadId = id;
        },
        onActivity: (value) => activities.push(value),
      })
      .then(finish, failure)
      .catch(failure);
  }
  process.on("message", (message: any) => {
    void (async () => {
      if (message.type === "pause") {
        runtime.setChatPaused("chat", true);
        const pending = runtime.captureTurnSuspension(threadId, turnId);
        void pending.catch(() => {});
        // The real accepted steer is also an ordered native-input boundary.
        await runtime.steerThread(
          "chat",
          threadId,
          message.input,
          [],
          model,
          provider,
        );
        send({ type: "input-accepted", input: message.input });
        const suspension = await pending;
        const evidence = await createManagedSuspensionCapture(
          runtime,
          store,
        )({
          session: {
            ...source(),
            runtimeGeneration: runtime.transportGeneration,
            connectionId: "fixture",
          },
          turnId,
          suspension,
        });
        send({ type: "paused", evidence, starts });
      } else if (message.type === "resume") {
        const active = await runtime.setActiveChatPaused("chat", false);
        send({ type: "resumed", active, starts });
      }
    })().catch(failure);
  });
} catch (error) {
  failure(error);
}

// Development wrapper around actual Node journal/ownership implementations.
import assert from "node:assert/strict";
import { WorkerInferenceJournal } from "../../tests/reference-node-worker/src/inference-journal.ts";
import { LocalNativeInferenceOwnership } from "../../tests/reference-node-worker/src/native-inference-ownership.ts";
import {
  launchCodexProcess,
  readCodexProcessEndpoint,
  openCodexWebSocket,
} from "../../tests/reference-node-worker/src/codex/process-transport.ts";
import { CodexRpcRequests } from "../../tests/reference-node-worker/src/codex/rpc-requests.ts";
import { parseCodexRpcMessage } from "../../tests/reference-node-worker/src/codex/rpc-protocol.ts";
export const settle = (pending) =>
  Promise.resolve(pending).then(
    (value) => JSON.parse(JSON.stringify({ ok: true, value })),
    (error) => ({ ok: false, error: error.message }),
  );
function corrupt(command, result, fault) {
  if (command.action === "snapshot" && fault === "snapshot-extra")
    result.unexpected = true;
  if (command.action !== "batch") return result;
  if (fault === "uncorrelated") return [];
  const first = result?.[0];
  if (!first) return result;
  if (fault === "entry-failure") first.ok = false;
  if (fault === "wrong-key") first.result.key = "f".repeat(64);
  if (fault === "wrong-worker")
    first.result.workerGeneration = "00000000-0000-4000-8000-000000000999";
  if (fault === "wrong-transition") first.result.state = "waiting";
  if (fault === "wrong-identity")
    first.result.identity.operationId = "another-operation";
  return result;
}
export class Reference {
  pending = new Map();
  calls = [];
  reports = [];
  lost = 0;
  fault = "";
  async reset() {
    if (this.runtime) {
      this.runtime.socket.close();
      this.runtime.child.kill("SIGINT");
      await this.runtime.closed;
      this.runtime = null;
    }
    await this.journal?.flush();
    await this.owner?.close();
    this.pending.clear();
    this.calls = [];
    this.reports = [];
    this.lost = 0;
    this.fault = "";
  }
  async call(input) {
    if (input.op === "new") {
      await this.reset();
      this.input = input;
      process.env.CANTRIP_NATIVE_OWNER_FIXTURE = JSON.stringify(
        input.config ?? {},
      );
      this.owner = new LocalNativeInferenceOwnership(
        input.binary,
        input.data,
        input.scope,
        (error) => this.reports.push(error.message),
      );
      this.owner.onLost(() => this.lost++);
      this.journal = new WorkerInferenceJournal(
        input.scope.workerGeneration,
        async (command) => {
          this.calls.push(command);
          return corrupt(
            command,
            await this.owner.journal(command),
            this.fault,
          );
        },
      );
      return null;
    }
    if (input.op === "fault") {
      this.fault = input.value;
      return null;
    }
    if (input.op === "recovery") return this.journal.recoverySnapshot();
    if (input.op === "status")
      return {
        available: this.owner.available,
        lost: this.lost,
        reports: this.reports,
        calls: this.calls,
      };
    if (input.op === "await") {
      const result = await this.pending.get(input.name);
      this.pending.delete(input.name);
      return result;
    }
    if (input.op === "tick") {
      await new Promise((resolve) => setTimeout(resolve, input.ms ?? 20));
      return null;
    }
    if (input.op === "runtime.open") {
      const env = await this.owner.prepare(input.runtime);
      const child = launchCodexProcess(
        this.input.binary,
        ["app-server", "--listen", "ws://127.0.0.1:0"],
        { env: { ...process.env, ...env, CODEX_HOME: this.input.home } },
      );
      const closed = new Promise((resolve, reject) => {
        child.once("close", resolve);
        child.once("error", reject);
      });
      const socket = await openCodexWebSocket(
        await readCodexProcessEndpoint(child, {
          runtimeId: null,
          readableError: (line) => line,
        }),
      );
      const requests = new CodexRpcRequests({
        send: (value) => socket.send(JSON.stringify(value)),
        runtimeId: () => null,
        secrets: () => new Set(),
        isZai: () => false,
        recordDiagnostic: () => "fixture",
      });
      this.runtime = { child, socket, requests, closed, exited: false };
      child.once("exit", () => {
        this.runtime.exited = true;
        requests.rejectAll(new Error("runtime exited"));
      });
      socket.on("message", (raw) => {
        const message = parseCodexRpcMessage(String(raw));
        if (message)
          requests.handleResponse(message, requests.diagnosticPayload(message));
      });
      socket.on("error", () => {});
      socket.on("close", () => requests.rejectAll(new Error("socket closed")));
      await requests.request(
        "initialize",
        {
          clientInfo: {
            name: "cantrip_inference_fixture",
            title: "Cantrip Inference Fixture",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            mcpServerOpenaiFormElicitation: true,
            requestAttestation: false,
          },
        },
        120_000,
      );
      socket.send(JSON.stringify({ method: "initialized", params: {} }));
      return null;
    }
    if (input.op === "runtime.status")
      return {
        connected: this.runtime.socket.readyState === 1,
        processExited: this.runtime.exited,
      };
    if (input.op === "runtime.exit") {
      await this.runtime.closed;
      assert.equal(this.runtime.exited, true);
      return { processExited: true };
    }
    let pending;
    switch (input.op) {
      case "prepare":
        pending = this.owner.prepare(input.runtime);
        break;
      case "retire":
        pending = this.owner.retire(input.runtime).then(() => null);
        break;
      case "close":
        pending = this.owner.close().then(() => null);
        break;
      case "raw":
        pending = this.owner.journal(input.command);
        break;
      case "initialize":
        pending = this.journal.initialize().then(() => null);
        break;
      case "snapshot":
        pending = this.journal.snapshot();
        break;
      case "flush":
        pending = this.journal.flush().then(() => null);
        break;
      case "enqueue":
        pending = this.journal.enqueue(input.key, input.identity);
        break;
      case "burst":
        pending = Promise.all(
          input.items.map((item) =>
            this.journal.enqueue(item.key, item.identity),
          ),
        );
        break;
      case "seal":
        pending = this.journal.sealUnstarted(input.key, input.identity);
        break;
      case "grant":
        pending = this.journal.grant(input.key);
        break;
      case "requeue":
        pending = this.journal.requeue(input.key);
        break;
      case "bind":
        pending = this.journal.bindNative(input.key, input.execution);
        break;
      case "release":
        pending = this.journal.release(input.key, input.outcome);
        break;
      case "forget":
        pending = this.journal.forget(input.previous).then(() => null);
        break;
      case "adopt":
        pending = this.journal.adopt(
          input.key,
          input.identity,
          input.previous,
          input.retainedOrder ?? null,
          input.cancel
            ? AbortSignal.abort(new Error("owned operation canceled"))
            : undefined,
          new Set(input.taskInputNotDispatched ?? []),
          new Set(input.goalInputNotDispatched ?? []),
          new Set(input.taskGoalCycleNotDispatched ?? []),
        );
        break;
      default:
        throw new Error("Unknown journal fixture operation");
    }
    if (input.start) {
      this.pending.set(input.name, settle(pending));
      return null;
    }
    return pending;
  }
}

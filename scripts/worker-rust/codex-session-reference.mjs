// A development adapter around the actual Node implementations, not an oracle reimplementation.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const WebSocket = createRequire(new URL("../../cantrip_worker/package.json", import.meta.url))("ws");
import { CodexRpcRequests } from "../../cantrip_worker/src/codex/rpc-requests.ts";
import { CodexNativeRpcError, CodexRpcObservationError, parseCodexRpcMessage } from "../../cantrip_worker/src/codex/rpc-protocol.ts";
import { launchCodexProcess, readCodexProcessEndpoint, openCodexWebSocket } from "../../cantrip_worker/src/codex/process-transport.ts";
import { readableCodexProviderError, safeEndpointDiagnosticPayload } from "../../cantrip_worker/src/codex/provider-errors.ts";
import { redactCodexDiagnosticPayload } from "../../cantrip_worker/src/codex/diagnostic-redaction.ts";
const wire = (value) => JSON.parse(JSON.stringify(value));
export function failure(error) {
  return { ok: false, kind: error instanceof CodexNativeRpcError ? "native" : error instanceof CodexRpcObservationError ? "observation" : "error", message: error.message,
    ...(error instanceof CodexNativeRpcError ? { nativeError: error.nativeError, requestMethod: error.requestMethod } : {}) };
}
export const settle = (work) => work.then((value) => wire({ ok: true, value }), failure);
export class Reference {
  frames = []; diagnostics = []; tickets = []; pending = new Map(); events = [];
  async close() {
    this.core?.rejectAll(new Error("Codex app-server client closed."));
    this.socket?.close(); this.child?.kill("SIGINT");
    if (this.finished) await this.finished;
    this.socket = null; this.child = null; this.finished = null; this.generation = false;
  }
  ports(input, send) {
    this.options = { secrets: new Set(input.secrets ?? []), zai: input.zai === true, endpoint: input.endpoint === true };
    return { send, runtimeId: () => null, secrets: () => this.options.secrets, isZai: () => this.options.zai, isEndpoint: () => this.options.endpoint,
      recordDiagnostic: (diagnostic, warning) => {
        diagnostic = redactCodexDiagnosticPayload(this.options.endpoint ? safeEndpointDiagnosticPayload(diagnostic) : diagnostic, this.options.secrets);
        this.diagnostics.push(wire({ kind: diagnostic.kind, method: diagnostic.method ?? null, payload: diagnostic.payload, warning: warning === undefined ? null : redactCodexDiagnosticPayload(warning, this.options.secrets) }));
        return "controlled-diagnostic-id";
      } };
  }
  response(message) {
    const payload = this.core.diagnosticPayload(message);
    this.portsValue.recordDiagnostic({ kind: "message", method: message.method ?? null, payload });
    return { handled: this.core.handleResponse(message, payload), payload };
  }
  async call(input) {
    switch (input.op) {
      case "new": case "session.open": {
        await this.close(); this.frames = []; this.diagnostics = []; this.tickets = []; this.events = []; this.pending.clear(); this.exited = false;
        if (input.op === "new") {
          this.portsValue = this.ports(input, (value) => { this.frames.push(value); if (input.sendError) throw new Error(input.sendError); });
          this.core = new CodexRpcRequests(this.portsValue); return null;
        }
        const child = launchCodexProcess(input.binary, ["app-server", "--listen", "ws://127.0.0.1:0"], { env: { ...process.env, PATH: "/usr/bin:/bin", CODEX_HOME: input.home, CANTRIP_CODEX_SESSION_FIXTURE: JSON.stringify(input.config ?? {}) } });
        this.child = child;
        this.finished = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
        const endpoint = await readCodexProcessEndpoint(child, { runtimeId: null, readableError: (line) => readableCodexProviderError(line, { secrets: new Set(input.secrets ?? []), zai: input.zai, endpoint: input.endpoint }) });
        const socket = await openCodexWebSocket(endpoint); this.socket = socket; this.generation = true;
        this.portsValue = this.ports(input, (value) => { if (!this.socket || socket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server is not writable."); socket.send(JSON.stringify(value)); });
        this.core = new CodexRpcRequests(this.portsValue);
        socket.on("message", (raw) => {
          if (this.socket !== socket) return;
          const message = parseCodexRpcMessage(raw.toString());
          if (!message) { this.portsValue.recordDiagnostic({ kind: "malformed", method: null, payload: raw.toString() }, "Malformed App Server message"); return; }
          // These owner-routed controls bypass general diagnostics in the
          // actual app-server handleMessage path, before CodexRpcRequests.
          if (message.method === "thread/nativeResources/requested" || message.method === "thread/managedExecution/requested" && message.params?.trigger === "inference") {
            this.events.push({ kind: "message", message, belongsToSession: true }); return;
          }
          if (!this.response(message).handled) this.events.push({ kind: "message", message, belongsToSession: true });
        });
        socket.on("error", () => {});
        socket.on("close", () => { if (this.socket !== socket) return; this.generation = false; this.core.rejectAll(new Error("Codex app-server WebSocket closed.")); this.events.push({ kind: "transportLost", message: "Codex app-server WebSocket closed.", belongsToSession: true }); child.kill("SIGINT"); });
        child.on("exit", (code) => { if (this.child !== child) return; this.exited = true; this.events.push({ kind: "processExited", code, belongsToSession: true }); });
        return null;
      }
      case "request": {
        const record = (state) => { this.tickets.push({ name: input.name ?? "", state }); if (input.failObserver === state) throw new Error("controlled observer failure"); };
        const observer = input.observe ? { replied: () => record("replied"), notSent: () => record("notSent") } : undefined;
        const work = settle(this.core.request(input.method, input.params, input.timeoutMs ?? null, observer));
        if (!input.abandon) this.pending.set(input.name ?? "a", work); return null;
      }
      case "await": { const value = await this.pending.get(input.name ?? "a"); this.pending.delete(input.name ?? "a"); return value; }
      case "response": return this.response(input.message);
      case "reject": this.core.rejectAll(new Error(input.message)); return null;
      case "snapshot": return wire({ frames: this.frames, diagnostics: this.diagnostics, tickets: this.tickets, pending: this.core.pendingCount });
      case "tick": await new Promise((resolve) => setTimeout(resolve, input.ms ?? 20)); return null;
      case "session.initialize": {
        const value = await this.core.request("initialize", { clientInfo: { name: "cantrip_native_session_fixture", title: "Cantrip Native Session Fixture", version: "0.0.0" }, capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true, requestAttestation: false } }, 120_000);
        this.portsValue.send({ method: "initialized", params: {} }); return value;
      }
      case "session.send": this.portsValue.send(input.message); return null;
      case "session.close": await this.close(); return null;
      case "session.status": return { pending: this.core.pendingCount, generation: this.generation, processExited: this.exited };
      case "session.event": {
        const until = Date.now() + (input.timeoutMs ?? 1000);
        while (!this.events.length && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 2));
        assert.ok(this.events.length, "real reference session event"); return this.events.shift();
      }
      default: throw new Error("Unknown reference operation");
    }
  }
}

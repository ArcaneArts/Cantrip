import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { workerCommandSchema } from "@cantrip/protocol";
import { verifyBuiltRuntime } from "../../scripts/cantrip-codex/verify-built-runtime.mjs";
import { managedTurnSessionContext } from "../../tests/reference-node-server/src/terminals/managed-session.js";
import { ManagedSuspensionResumes } from "../src/codex/managed-suspension-resume.js";
import { openManagedSuspensionSource } from "../src/codex/managed-suspended-source.js";
import { createNativeSharedViewFixture } from "./native-shared-view-fixture.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
type Json = Record<string, any>;
type Request = { body: Json; response: ServerResponse };

function send(request: Request, item: Json, id: string) {
  for (const event of [
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id,
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    },
  ])
    request.response.write(
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );
  request.response.end();
}
function answer(request: Request, text: string) {
  send(
    request,
    {
      type: "message",
      role: "assistant",
      id: text,
      phase: "final_answer",
      content: [{ type: "output_text", text }],
    },
    text,
  );
}
function call(request: Request, leaf: string, args: Json, id: string) {
  const tools = request.body.tools.flatMap((entry: Json) =>
    entry.type === "namespace"
      ? entry.tools.map((tool: Json) => ({ ...tool, namespace: entry.name }))
      : [entry],
  );
  const tool = tools.find(
    (entry: Json) => entry.name === leaf || entry.name.endsWith(`__${leaf}`),
  );
  expect(tool, `${leaf} must actually be advertised`).toBeDefined();
  send(
    request,
    {
      type: "function_call",
      id,
      call_id: id,
      name: tool.name,
      ...(tool.namespace ? { namespace: tool.namespace } : {}),
      arguments: JSON.stringify(args),
    },
    id,
  );
}
const output = (request: Request, id: string) =>
  request.body.input.find(
    (item: Json) => item.type === "function_call_output" && item.call_id === id,
  )?.output;

describe.skipIf(!binary)("native subagent suspension policy", () => {
  it.each(["v1", "v2"] as const)(
    "enforces the %s native child boundary without replay",
    async (version) => {
      await verifyBuiltRuntime(path.dirname(binary!));
      const requests: Request[] = [];
      const provider = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        if (!request.url?.startsWith("/v1/")) {
          response.writeHead(404).end();
          return;
        }
        requests.push({ body: JSON.parse(body), response });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `child-policy-${requests.length}` } })}\n\n`,
        );
      });
      const isChild = (request: Request) => {
        const raw = request.body.client_metadata?.["x-codex-turn-metadata"];
        if (
          typeof raw === "string" &&
          JSON.parse(raw).parent_thread_id === f?.threadId
        )
          return true;
        return request.body.input.some(
          (item: Json) =>
            item.type === "message" &&
            JSON.stringify(item.content).includes("NATIVE_CHILD_WORK"),
        );
      };
      const roots = () => requests.filter((request) => !isChild(request));
      let f:
        Awaited<ReturnType<typeof createNativeSharedViewFixture>> | undefined;
      try {
        provider.listen(0, "127.0.0.1");
        await once(provider, "listening");
        const endpoint = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
        f = await createNativeSharedViewFixture(binary!, endpoint, {
          durablePause: true,
          multiAgentV2: version === "v2",
        });
        await f.guiStart("NATIVE_PARENT_WORK");
        await vi.waitFor(() => expect(roots()).toHaveLength(1), {
          timeout: 15000,
        });
        const turnId = f.frames.find(
          (frame) =>
            frame.method === "turn/started" &&
            frame.params.threadId === f!.threadId,
        )!.params.turn.id;
        call(
          roots()[0]!,
          "spawn_agent",
          version === "v1"
            ? { message: "NATIVE_CHILD_WORK", fork_context: false }
            : {
                message: "NATIVE_CHILD_WORK",
                task_name: "child",
                fork_turns: "none",
              },
          "spawn-child",
        );
        await vi.waitFor(
          () => {
            expect(roots()).toHaveLength(2);
            expect(requests.filter(isChild)).toHaveLength(1);
          },
          { timeout: 15000 },
        );
        const spawned = JSON.parse(output(roots()[1]!, "spawn-child"));
        const childId = version === "v1" ? spawned.agent_id : spawned.task_name;
        expect(typeof childId).toBe("string");
        answer(requests.find(isChild)!, "NATIVE_CHILD_RESULT");
        call(
          roots()[1]!,
          "wait_agent",
          version === "v1"
            ? { targets: [childId], timeout_ms: 1000 }
            : { timeout_ms: 1000 },
          "wait-child",
        );
        await vi.waitFor(() => expect(roots()).toHaveLength(3), {
          timeout: 15000,
        });
        if (version === "v1")
          expect(JSON.stringify(output(roots()[2]!, "wait-child"))).toContain(
            "NATIVE_CHILD_RESULT",
          );
        else {
          expect(JSON.stringify(output(roots()[2]!, "wait-child"))).not.toMatch(
            /failed|parse|unknown field/i,
          );
          expect(JSON.stringify(roots()[2]!.body.input)).toContain(
            "NATIVE_CHILD_RESULT",
          );
        }

        const refused = f.runtime
          .setActiveChatPaused(f.authority.chatId, true)
          .then(
            (result) => ({ result, error: null }),
            (error) => ({ result: null, error }),
          );
        await vi.waitFor(async () =>
          expect(
            await f!.authority.repository.nativeSuspensions.read(
              f!.authority.ownerId,
              f!.authority.chatId,
            ),
          ).toMatchObject({ phase: "pausing" }),
        );
        call(
          roots()[2]!,
          "exec_command",
          { cmd: ":", yield_time_ms: 1000 },
          "refusal-boundary",
        );
        const refusal = await refused;
        const inspected = await f.runtime.inspectTurnSuspension(f.threadId);
        expect({
          error: refusal.error?.message ?? null,
          captures: f.captures.length,
          nativePaused: inspected.paused,
          nativeCheckpoint: Boolean(inspected.suspension),
        }).toMatchObject({
          error: expect.stringMatching(/subagent trees/i),
          captures: 0,
          nativeCheckpoint: false,
        });
        expect(f.captures).toHaveLength(0);
        expect(
          await f.authority.repository.nativeSuspensions.read(
            f.authority.ownerId,
            f.authority.chatId,
          ),
        ).toMatchObject({
          phase: "error",
          checkpoint: null,
          active: { threadId: f.threadId, turnId },
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(roots()).toHaveLength(3);
        await f.runtime.setActiveChatPaused(f.authority.chatId, false);
        await vi.waitFor(() => expect(roots()).toHaveLength(4), {
          timeout: 15000,
        });
        if (version === "v2") {
          // V2 retains completed agents for follow-up and has no close_agent tool.
          // Keep the tree explicitly non-durable; live Resume and Stop still work.
          expect(
            await f.runtime.interruptChat(f.authority.chatId, f.threadId),
          ).toEqual({ interrupted: true });
          await vi.waitFor(async () =>
            expect(
              await f!.authority.repository.nativeSuspensions.read(
                f!.authority.ownerId,
                f!.authority.chatId,
              ),
            ).toMatchObject({
              phase: "stopped",
              checkpoint: null,
              active: { threadId: f!.threadId, turnId },
            }),
          );
          expect(f.captures).toHaveLength(0);
          expect(requests.filter(isChild)).toHaveLength(1);
          return;
        }
        call(roots()[3]!, "close_agent", { target: childId }, "close-child");
        await vi.waitFor(() => expect(roots()).toHaveLength(5), {
          timeout: 15000,
        });
        expect(JSON.stringify(output(roots()[4]!, "close-child"))).toContain(
          "completed",
        );

        const pausing = f.runtime.setActiveChatPaused(f.authority.chatId, true);
        void pausing.catch(() => {});
        await f.guiSteer("NATIVE_CHILD_CLOSED_STEER");
        answer(roots()[4]!, "PARENT_AFTER_CHILD");
        expect(await pausing).toEqual({ threadId: f.threadId, turnId });
        expect(f.captures).toHaveLength(1);
        const evidence = f.captures[0]!;
        const source = await f.suspensionStore.open(evidence.storageId, {
          chatId: f.authority.chatId,
          threadId: f.threadId,
          contextKind: "project",
          projectId: f.authority.projectId,
          placementId: f.authority.placementId!,
          modelRouteId: f.authority.modelRuntime.routeId,
          providerAccountId: null,
        });
        const beforeRestart = requests.length;
        const fresh = await f.restartRuntime(undefined, evidence);
        expect(await f.runtime.inspectTurnSuspension(f.threadId)).toMatchObject(
          {
            paused: true,
            suspension: evidence.suspension,
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(requests).toHaveLength(beforeRestart);
        const requested =
          await f.authority.repository.nativeSuspensions.request(
            f.authority.ownerId,
            f.authority.chatId,
            "resume",
          );
        const command = workerCommandSchema.parse({
          type: "chat.suspension.resume",
          chatId: f.authority.chatId,
          threadId: f.threadId,
          controlId: requested.state.controlId,
          checkpoint: evidence,
          nativeActivationGeneration: null,
          nativeRuntimeGeneration: fresh.oldGeneration,
          session: {
            ...managedTurnSessionContext(f.authority.context)!,
            heldSuspension: evidence,
          },
          cwd: source.continuation!.cwd,
          executionProfile: "ide",
          model: source.continuation!.model,
          provider: {
            id: source.continuation!.providerId,
            kind: source.continuation!.providerKind,
            name: "Fixture",
            baseUrl: endpoint,
            apiKey: null,
          },
          permissionProfileId: ":workspace",
          planMode: "default",
          subagentDefaults: null,
          mcpServers: [],
        });
        if (command.type !== "chat.suspension.resume")
          throw new Error("Resume command");
        const coordinator = new ManagedSuspensionResumes({
          encryption: fresh.encryption,
          signal: () => new AbortController().signal,
          active: () => null,
          prepare: async () => ({
            session: fresh.session,
            runtime: f!.runtime,
            adapter: fresh.adapter,
          }),
          openSource: (command) =>
            openManagedSuspensionSource({
              store: f!.suspensionStore,
              session: command.session,
              threadId: command.threadId,
              modelRouteId: fresh.session.modelRouteId,
              providerAccountId: fresh.session.providerAccountId,
            }),
          client: fresh.client,
        });
        expect(await coordinator.run(command)).toEqual({
          paused: false,
          active: { threadId: f.threadId, turnId },
        });
        await vi.waitFor(() => expect(roots()).toHaveLength(6), {
          timeout: 15000,
        });
        const resumed = roots()[5]!;
        expect(JSON.stringify(output(resumed, "wait-child"))).toContain(
          "NATIVE_CHILD_RESULT",
        );
        expect(
          resumed.body.input.filter(
            (item: Json) =>
              item.type === "function_call_output" &&
              item.call_id === "wait-child",
          ),
        ).toHaveLength(1);
        expect(JSON.stringify(resumed.body.input)).toContain(
          "NATIVE_CHILD_CLOSED_STEER",
        );
        expect(requests.filter(isChild)).toHaveLength(1);
        answer(resumed, "NATIVE_PARENT_RECOVERED");
        await vi.waitFor(
          async () =>
            expect(
              await f!.authority.repository.nativeSuspensions.read(
                f!.authority.ownerId,
                f!.authority.chatId,
              ),
            ).toMatchObject({ phase: "completed", checkpoint: null }),
          { timeout: 15000 },
        );
        expect(
          f.frames.filter(
            (frame) =>
              frame.method === "turn/started" &&
              frame.params.turn.id === turnId,
          ),
        ).toHaveLength(1);
        expect(
          f.frames.filter(
            (frame) =>
              frame.method === "turn/started" &&
              frame.params.threadId === childId,
          ),
        ).toHaveLength(1);
      } finally {
        await f?.close();
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
      }
    },
    90000,
  );
});

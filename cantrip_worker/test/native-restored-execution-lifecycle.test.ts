import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { verifyBuiltRuntime } from "../../scripts/cantrip-codex/verify-built-runtime.mjs";
import { workerCommandSchema } from "@cantrip/protocol";
import { managedTurnSessionContext } from "../../cantrip_server/src/terminals/managed-session.js";
import { ManagedSuspensionResumes } from "../src/codex/managed-suspension-resume.js";
import { openManagedSuspensionSource } from "../src/codex/managed-suspended-source.js";
import { createNativeSharedViewFixture } from "./native-shared-view-fixture.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
function answer(response: ServerResponse, text: string) {
  for (const event of [
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: text,
        phase: "final_answer",
        content: [{ type: "output_text", text }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: text,
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    },
  ])
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

// This component integration kills and replaces the native process. The
// separate cold-worker fixture covers whole-worker termination; production
// server-to-worker Resume delivery is intentionally not simulated here.
describe.skipIf(!binary || process.platform === "win32")(
  "fresh native observer lifecycle with real server admission",
  () => {
    it.each([
      ["gui", "complete"],
      ["terminal", "complete"],
      ["gui", "stop"],
      ["terminal", "stop"],
    ] as const)(
      "restores %s input under its original provenance and handles %s",
      async (origin, ending) => {
        await verifyBuiltRuntime(path.dirname(binary!));
        const requests: {
          body: Record<string, any>;
          response: ServerResponse;
        }[] = [];
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
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `native-lifecycle-${requests.length}` } })}\n\n`,
          );
        });
        let f:
          Awaited<ReturnType<typeof createNativeSharedViewFixture>> | undefined;
        let releaseResume: (() => void) | undefined;
        try {
          provider.listen(0, "127.0.0.1");
          await once(provider, "listening");
          f = await createNativeSharedViewFixture(
            binary!,
            `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
            { durablePause: true },
          );
          let gui: Awaited<ReturnType<typeof f.guiStart>> | undefined;
          if (origin === "gui")
            gui = await f.guiStart("ORIGINAL_LIFECYCLE_INPUT");
          else await f.tuiSend("ORIGINAL_LIFECYCLE_INPUT");
          await vi.waitFor(() => expect(requests).toHaveLength(1), {
            timeout: 15000,
          });
          const pause = f.runtime.setActiveChatPaused(f.authority.chatId, true);
          void pause.catch(() => {});
          await vi.waitFor(
            async () =>
              expect(
                (
                  await f!.authority.repository.nativeSuspensions.read(
                    f!.authority.ownerId,
                    f!.authority.chatId,
                  )
                )?.phase,
              ).toBe("pausing"),
            { timeout: 15000 },
          );
          await f.guiSteer("ACCEPTED_LIFECYCLE_STEER");
          answer(requests[0]!.response, "BEFORE_LIFECYCLE_PAUSE");
          const active = await pause;
          expect(active).not.toBeNull();
          const evidence = f.captures.at(-1)!;
          expect(evidence.suspension).toMatchObject(active!);
          const source = await f.suspensionStore.open(evidence.storageId, {
            chatId: f.authority.chatId,
            threadId: f.threadId,
            contextKind: "project",
            projectId: f.authority.projectId,
            placementId: f.authority.placementId!,
            modelRouteId: f.authority.modelRuntime.routeId,
            providerAccountId: null,
          });
          expect(source.continuation).not.toBeNull();
          const fresh = await f.restartRuntime(undefined, evidence);
          expect(fresh.session.runtimeGeneration).not.toBe(fresh.oldGeneration);
          expect(
            await f.runtime.inspectTurnSuspension(f.threadId),
          ).toMatchObject({ paused: true, suspension: evidence.suspension });
          expect(requests).toHaveLength(1);
          const requested =
            await f.authority.repository.nativeSuspensions.request(
              f.authority.ownerId,
              f.authority.chatId,
              "resume",
            );
          let grant!: Awaited<
            ReturnType<typeof fresh.client.admitSuspendedExecution>
          >;
          let restored!: Awaited<
            ReturnType<typeof fresh.adapter.restoreSuspendedExecution>
          >;
          const resumeGate = new Promise<void>((resolve) => {
            releaseResume = resolve;
          });
          let held!: () => void;
          const heldReady = new Promise<void>((resolve) => {
            held = resolve;
          });
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
              baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
              apiKey: null,
            },
            permissionProfileId: ":workspace",
            planMode: "default",
            subagentDefaults: null,
            mcpServers: [],
          });
          if (command.type !== "chat.suspension.resume")
            throw new Error("Resume fixture packet");
          const coordinator = new ManagedSuspensionResumes({
            encryption: fresh.encryption,
            signal: () => new AbortController().signal,
            active: () => null,
            prepare: async () => ({
              session: fresh.session,
              runtime: {
                setActiveChatPaused: async (chat, paused) => {
                  held();
                  await resumeGate;
                  return f!.runtime.setActiveChatPaused(chat, paused);
                },
                isChatPaused: (chat) => f!.runtime.isChatPaused(chat),
              },
              adapter: {
                get currentActivationGeneration() {
                  return fresh.adapter.currentActivationGeneration;
                },
                withExpectedActivationGeneration:
                  fresh.adapter.withExpectedActivationGeneration.bind(
                    fresh.adapter,
                  ),
                restoreSuspendedExecution: async (...args) => {
                  const [one, two] = await Promise.all([
                    fresh.adapter.restoreSuspendedExecution(...args),
                    fresh.adapter.restoreSuspendedExecution(...args),
                  ]);
                  expect(two).toBe(one);
                  restored = one;
                  return one;
                },
              },
            }),
            openSource: (command) =>
              openManagedSuspensionSource({
                store: f!.suspensionStore,
                session: command.session,
                threadId: command.threadId,
                modelRouteId: fresh.session.modelRouteId,
                providerAccountId: fresh.session.providerAccountId,
              }),
            client: {
              admitSuspendedExecution: async (...args) => {
                grant = await fresh.client.admitSuspendedExecution(...args);
                return grant;
              },
            },
          });
          const resuming = coordinator.run(command);
          void resuming.catch(() => {});
          expect(coordinator.run(structuredClone(command))).toBe(resuming);
          await heldReady;
          expect(grant.receipt.operationId).not.toBe(grant.source.operationId);
          expect(Boolean(grant.logicalRoot)).toBe(origin === "gui");
          expect(f.publicationSources.at(-1)).toEqual(grant.source);
          expect(
            (
              await f.authority.repository.nativeSuspensions.read(
                f.authority.ownerId,
                f.authority.chatId,
              )
            )?.phase,
          ).toBe("resuming");
          expect(
            await f.runtime.inspectTurnSuspension(f.threadId),
          ).toMatchObject({ paused: true, suspension: evidence.suspension });
          if (grant.logicalRoot) {
            expect(
              await f.authority.repository.nativeCommands.finishLogicalGui(
                f.authority.ownerId,
                f.authority.workerId,
                grant.logicalRoot.operationId,
                grant.logicalRoot.operationGeneration,
                "idle",
                true,
              ),
            ).toBe(false);
            expect(
              await f.authority.repository.nativeCommands.getLogicalCompletion(
                f.authority.ownerId,
                f.authority.workerId,
                f.authority.chatId,
                grant.logicalRoot.operationId,
                grant.logicalRoot.operationGeneration,
              ),
            ).toBeNull();
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
          expect(requests).toHaveLength(1);
          if (ending === "stop") {
            const stopped =
              await f.authority.repository.nativeSuspensions.request(
                f.authority.ownerId,
                f.authority.chatId,
                "stop",
              );
            releaseResume!();
            await expect(resuming).rejects.toMatchObject({
              code: "restore-failed",
            });
            expect(
              (await f.runtime.inspectTurnSuspension(f.threadId)).paused,
            ).toBe(true);
            expect(requests).toHaveLength(1);
            expect(
              await fresh.adapter.withExpectedActivationGeneration(
                grant.receipt.activationGeneration,
                () =>
                  f!.runtime.interruptChat(f!.authority.chatId, f!.threadId),
                stopped.state.controlId,
              ),
            ).toEqual({ interrupted: true });
            await restored.completion;
            expect(
              await f.authority.repository.nativeSuspensions.read(
                f.authority.ownerId,
                f.authority.chatId,
              ),
            ).toMatchObject({ phase: "stopped", checkpoint: null, active });
          } else {
            releaseResume!();
            expect(await resuming).toEqual({ paused: false, active });
            await vi.waitFor(() => expect(requests).toHaveLength(2), {
              timeout: 15000,
            });
            const input = JSON.stringify(requests[1]!.body.input);
            expect(input.split("ORIGINAL_LIFECYCLE_INPUT")).toHaveLength(2);
            expect(input.split("ACCEPTED_LIFECYCLE_STEER")).toHaveLength(2);
            expect(
              (
                await f.authority.repository.nativeSuspensions.read(
                  f.authority.ownerId,
                  f.authority.chatId,
                )
              )?.phase,
            ).toBe("running");
            answer(requests[1]!.response, "RESTORED_LIFECYCLE_COMPLETE");
            await restored.completion;
            const ended = await f.authority.repository.nativeSuspensions.read(
              f.authority.ownerId,
              f.authority.chatId,
            );
            expect(ended).toMatchObject({
              phase: "completed",
              checkpoint: null,
              active,
            });
          }
          const history = await f.runtime.readNativeHistory(f.threadId);
          expect(history.thread.turns).toHaveLength(1);
          expect(history.thread.turns[0]!.id).toBe(evidence.suspension.turnId);
          expect(f.completed).toEqual(
            ending === "complete" ? [evidence.suspension.turnId] : [],
          );
          expect(
            f.authority.phases.some(
              ({ phase, body }) =>
                phase === "admit" &&
                body.method === "turn/pause" &&
                body.intent.expectedSuspensionControlId ===
                  requested.state.controlId,
            ),
          ).toBe(true);
          if (gui) await gui.settled;
          if (grant.logicalRoot) {
            // The original caller died with its transport. Native settlement
            // must retire its logical input and publish the completion itself.
            expect(
              await f.authority.repository.nativeCommands.getLogicalCompletion(
                f.authority.ownerId,
                f.authority.workerId,
                f.authority.chatId,
                grant.logicalRoot.operationId,
                grant.logicalRoot.operationGeneration,
              ),
            ).toMatchObject({ rootOperationId: grant.logicalRoot.operationId });
          }
        } finally {
          releaseResume?.();
          for (const request of requests) request.response.destroy();
          provider.closeAllConnections();
          await f?.close();
          if (provider.listening)
            await new Promise<void>((resolve) =>
              provider.close(() => resolve()),
            );
        }
      },
      90000,
    );
  },
);

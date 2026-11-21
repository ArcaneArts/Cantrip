import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CodexRpcClient } from "../src/codex/rpc-client.js";
import { readCodexNativeHistory } from "../src/codex/native-history.js";
import { requestManagedHistoryTransfer } from "../src/codex/managed-history-transfer.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
type Json = Record<string, any>;

describe.skipIf(!binary)(
  "native portable history across provider homes",
  () => {
    it.each(["legacy", "paginated"])(
      "preserves %s history in another home",
      async (historyMode) => {
        const directory = await mkdtemp(
          path.join(tmpdir(), "cantrip-home-probe-"),
        );
        const cwd = path.join(directory, "workspace");
        const requests: { url: string; body: Json }[] = [];
        let releaseResponse: (() => void) | undefined;
        let holdResponse = false;
        const provider = createServer(async (request, response) => {
          let body = "";
          for await (const chunk of request) body += chunk.toString();
          requests.push({ url: request.url!, body: JSON.parse(body) });
          if (holdResponse) {
            await new Promise<void>((resolve) => {
              releaseResponse = resolve;
            });
          }
          const n = requests.length;
          const events = [
            { type: "response.created", response: { id: `response-${n}` } },
            {
              type: "response.output_item.done",
              item: {
                type: "message",
                role: "assistant",
                id: `answer-${n}`,
                content: [{ type: "output_text", text: `Answer ${n}` }],
              },
            },
            {
              type: "response.completed",
              response: {
                id: `response-${n}`,
                usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
              },
            },
          ];
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            events
              .map(
                (event) =>
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              )
              .join(""),
          );
        });
        let child: ChildProcessWithoutNullStreams | undefined;
        let client: CodexRpcClient | undefined;
        const admissionErrors: unknown[] = [];
        const declinedAttempts: string[] = [];
        const rpc = async (method: string, params: Json): Promise<Json> => {
          const request = async (name: string, input: unknown) => {
            const result = await client!.request(name, input);
            if (result.error)
              throw new Error(`${name}: ${result.error.message}`);
            return result.result as Json;
          };
          if (
            method === "thread/managedHistory/export" ||
            method === "thread/managedHistory/import"
          )
            return requestManagedHistoryTransfer(
              request,
              () => client,
              method,
              params,
            );
          return request(method, params);
        };
        const stop = async () => {
          if (!child) return;
          const closing = child;
          const exit = once(closing, "close");
          const force = setTimeout(() => closing.kill("SIGKILL"), 5000);
          client!.close();
          await exit.finally(() => clearTimeout(force));
          child = undefined;
        };
        const start = async (
          account: "a" | "b",
          namespace = account as string,
        ) => {
          const home = path.join(directory, namespace);
          await mkdir(home, { recursive: true });
          await writeFile(
            path.join(home, "config.toml"),
            [
              'model="gpt-5"',
              `model_provider="fixture-${account}"`,
              `approval_policy="${account === "a" ? "never" : "on-request"}"`,
              `sandbox_mode="${account === "a" ? "read-only" : "danger-full-access"}"`,
              `model_reasoning_effort="${account === "a" ? "high" : "low"}"`,
              "features.plugins=false",
              "features.goals=true",
              `[model_providers.fixture-${account}]`,
              `name="Fixture ${account}"`,
              `base_url="http://127.0.0.1:${(provider.address() as { port: number }).port}/${account}/v1"`,
              'wire_api="responses"',
              "requires_openai_auth=false",
              "request_max_retries=0",
              "stream_max_retries=0",
              "",
            ].join("\n"),
          );
          child = spawn(binary!, ["app-server"], {
            cwd,
            env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
            stdio: "pipe",
          });
          client = new CodexRpcClient(child, 15000);
          const connection = client;
          const events = createInterface({ input: child.stdout });
          events.on("line", (line) => {
            let event: Json;
            try {
              event = JSON.parse(line);
            } catch {
              return;
            }
            if (event.method !== "thread/managedExecution/requested") return;
            const { threadId, runnerGeneration, attemptId, trigger } =
              event.params;
            // This storage fixture retains queued input for transfer. Answer the
            // real admission request, as the managed host does, without starting it.
            void connection
              .request("thread/managedExecution/resolve", {
                threadId,
                runnerGeneration,
                attemptId,
                operationGeneration: null,
                allow: false,
              })
              .then((result) => {
                expect(["queue", "goal"]).toContain(trigger);
                expect(result.error).toBeUndefined();
                expect(result.result).toEqual({ accepted: true });
                declinedAttempts.push(attemptId);
              })
              .catch((error) => admissionErrors.push(error));
          });
          child.once("close", () => events.close());
          await rpc("initialize", {
            clientInfo: { name: "cantrip_home_probe", version: "1" },
            capabilities: { experimentalApi: true },
          });
          client.notify("initialized");
        };
        const turn = async (threadId: string, text: string) => {
          const started = await rpc("turn/start", {
            threadId,
            input: [{ type: "text", text }],
          });
          const finished = await client!.waitForNotification(
            "turn/completed",
            (params: any) => params?.turn?.id === started.turn.id,
          );
          expect((finished.params as Json).turn.status).toBe("completed");
          return started.turn.id as string;
        };
        try {
          await mkdir(cwd);
          provider.listen(0, "127.0.0.1");
          await once(provider, "listening");
          await start("a");
          const managedConfig = {
            mcpServers: {},
            developerInstructions: "Managed fixture",
            multiAgentEnabled: false,
            subagentModel: null,
            subagentReasoningEffort: null,
            canonicalHistory: true,
            // Managed queues are dispatched by the host, not by native idle hooks.
            executionGate: { runnerGeneration: randomUUID() },
          };
          const initial = await rpc("thread/start", {
            cwd,
            historyMode,
            serviceTier: "priority",
            managedConfig,
          });
          const threadId = initial.thread.id;
          const emptyTransferId = randomUUID();
          const emptyExport = await rpc("thread/managedHistory/export", {
            threadId,
            transferId: emptyTransferId,
            expectedLastTurnId: null,
          });
          expect(requests).toHaveLength(0);
          await rpc("thread/memoryMode/set", { threadId, mode: "disabled" });
          const section = (
            await rpc("threadSection/create", {
              name: "Transfer section",
              appearance: { icon: "music", color: "violet" },
            })
          ).section;
          await rpc("thread/section/move", { threadId, sectionId: section.id });
          const project = (
            await rpc("project/create", {
              name: "Transfer project",
              roots: [{ path: cwd }],
              metadata: { fixture: "selected conversation" },
              idempotencyKey: randomUUID(),
            })
          ).project;
          await rpc("thread/metadata/update", {
            threadId,
            projectId: project.id,
          });
          await rpc("thread/goal/set", {
            threadId,
            objective: "Retain this fixture goal",
            tokenBudget: 1000,
            status: "active",
          });
          const firstTurnId = await turn(threadId, "BEFORE_MIGRATION");
          await expect
            .poll(
              async () =>
                (await rpc("thread/goal/get", { threadId })).goal?.tokensUsed,
            )
            .toBeGreaterThan(0);
          await rpc("thread/goal/set", { threadId, status: "paused" });
          const sourceGoal = await rpc("thread/goal/get", { threadId });
          const source = await readCodexNativeHistory(rpc, threadId);
          const sourceRead = await rpc("thread/read", {
            threadId,
            includeTurns: false,
          });
          expect(sourceRead.thread.path).toEqual(expect.any(String));
          const queued = await rpc("thread/queue/add", {
            threadId,
            input: [{ type: "text", text: "pending after migration" }],
            clientUserMessageId: "migration-queued-message",
          });
          const transferId = randomUUID();
          await expect(
            rpc("thread/managedHistory/export", {
              threadId,
              transferId: randomUUID(),
              expectedLastTurnId: "stale-turn",
            }),
          ).rejects.toThrow("stale native turn");
          const exported = await rpc("thread/managedHistory/export", {
            threadId,
            transferId,
            expectedLastTurnId: firstTurnId,
          });
          const sourceTransfer = JSON.parse(
            await readFile(exported.path, "utf8"),
          );
          if (historyMode === "legacy") {
            const metadataRecords = sourceTransfer.segments.flatMap(
              (segment: Json) =>
                segment.content
                  .split("\n")
                  .filter(Boolean)
                  .map((line: string) => JSON.parse(line))
                  .filter((line: Json) => line.type === "session_meta"),
            );
            expect(metadataRecords.length).toBeGreaterThan(1);
            expect(
              metadataRecords.some(
                (record: Json) => record.payload.memory_mode === "disabled",
              ),
            ).toBe(true);
          }
          expect(sourceTransfer.version).toBe(2);
          expect(sourceTransfer.state).toMatchObject({
            memory_mode: "disabled",
            project: { id: project.id, name: project.name },
            goal: { objective: "Retain this fixture goal", status: "paused" },
          });
          expect(
            await rpc("thread/managedHistory/export", {
              threadId,
              transferId,
              expectedLastTurnId: firstTurnId,
            }),
          ).toEqual(exported);
          await stop();
          await start("b");
          // Later metadata is valid history, but it cannot replace the first
          // record's ownership or bypass the transfer envelope version.
          const invalidTransferPath = path.join(
            directory,
            "invalid-transfer.json",
          );
          await writeFile(
            invalidTransferPath,
            JSON.stringify({ ...sourceTransfer, version: 1 }),
          );
          await expect(
            rpc("thread/managedHistory/import", {
              threadId,
              transferId: randomUUID(),
              path: invalidTransferPath,
            }),
          ).rejects.toThrow("invalid portable history identity or version");
          const foreignRoot = structuredClone(sourceTransfer);
          const rootSegment = foreignRoot.segments.at(-1);
          const rootLines = rootSegment.content.split("\n");
          const foreignHeader = JSON.parse(rootLines[0]);
          foreignHeader.payload.id = randomUUID();
          foreignHeader.payload.session_id = foreignHeader.payload.id;
          rootLines[0] = JSON.stringify(foreignHeader);
          rootSegment.content = rootLines.join("\n");
          await writeFile(invalidTransferPath, JSON.stringify(foreignRoot));
          await expect(
            rpc("thread/managedHistory/import", {
              threadId,
              transferId: randomUUID(),
              path: invalidTransferPath,
            }),
          ).rejects.toThrow(
            "portable history root belongs to another conversation",
          );
          // Fail the actual publication write after auxiliary state is staged.
          // Only this fixture's private databases are opened directly.
          const stateDb = new DatabaseSync(
            path.join(directory, "b", "state_5.sqlite"),
          );
          try {
            stateDb.exec("PRAGMA busy_timeout = 5000");
            stateDb.exec(
              "CREATE TRIGGER fail_imported_thread BEFORE INSERT ON threads BEGIN SELECT RAISE(ABORT, 'fixture import write failure'); END",
            );
            await expect(
              rpc("thread/managedHistory/import", {
                threadId,
                transferId,
                path: exported.path,
              }),
            ).rejects.toThrow("fixture import write failure");
            expect(
              stateDb
                .prepare("SELECT id FROM threads WHERE id = ?")
                .get(threadId),
            ).toBeUndefined();
            expect(
              stateDb
                .prepare("SELECT id FROM projects WHERE id = ?")
                .get(project.id),
            ).toBeUndefined();
            expect(
              stateDb
                .prepare("SELECT id FROM thread_sections WHERE id = ?")
                .get(section.id),
            ).toBeUndefined();
            stateDb.exec("DROP TRIGGER fail_imported_thread");
            stateDb
              .prepare("INSERT INTO thread_sections(id, name) VALUES (?, ?)")
              .run(section.id, "Destination section");
            await expect(
              rpc("thread/managedHistory/import", {
                threadId,
                transferId,
                path: exported.path,
              }),
            ).rejects.toThrow("destination section already differs");
            expect(
              stateDb
                .prepare("SELECT name FROM thread_sections WHERE id = ?")
                .get(section.id),
            ).toEqual({ name: "Destination section" });
            stateDb
              .prepare("DELETE FROM thread_sections WHERE id = ?")
              .run(section.id);
            const transferredProject = sourceTransfer.state.project;
            stateDb
              .prepare(
                "INSERT INTO projects(id, name, metadata, position, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .run(
                project.id,
                "Destination project",
                JSON.stringify(transferredProject.metadata),
                transferredProject.position,
                transferredProject.created_at_ms,
                transferredProject.updated_at_ms,
              );
            await expect(
              rpc("thread/managedHistory/import", {
                threadId,
                transferId,
                path: exported.path,
              }),
            ).rejects.toThrow("destination project already differs");
            expect(
              stateDb
                .prepare("SELECT name FROM projects WHERE id = ?")
                .get(project.id),
            ).toEqual({ name: "Destination project" });
            stateDb
              .prepare("DELETE FROM projects WHERE id = ?")
              .run(project.id);
          } finally {
            stateDb.close();
          }
          // Goals publish in their own database. A retry must reject a changed
          // goal rather than overwrite it with the old transfer artifact.
          const goalsDb = new DatabaseSync(
            path.join(directory, "b", "goals_1.sqlite"),
          );
          try {
            goalsDb.exec("PRAGMA busy_timeout = 5000");
            expect(
              goalsDb
                .prepare(
                  "SELECT objective FROM thread_goals WHERE thread_id = ?",
                )
                .get(threadId),
            ).toEqual({ objective: "Retain this fixture goal" });
            goalsDb
              .prepare(
                "UPDATE thread_goals SET objective = ? WHERE thread_id = ?",
              )
              .run("Changed destination goal", threadId);
            await expect(
              rpc("thread/managedHistory/import", {
                threadId,
                transferId,
                path: exported.path,
              }),
            ).rejects.toThrow("destination goal already differs");
            expect(
              goalsDb
                .prepare(
                  "SELECT objective FROM thread_goals WHERE thread_id = ?",
                )
                .get(threadId),
            ).toEqual({ objective: "Changed destination goal" });
            goalsDb
              .prepare(
                "UPDATE thread_goals SET objective = ? WHERE thread_id = ?",
              )
              .run("Retain this fixture goal", threadId);
          } finally {
            goalsDb.close();
          }
          const imported = await rpc("thread/managedHistory/import", {
            threadId,
            transferId,
            path: exported.path,
          });
          expect(
            await rpc("thread/managedHistory/import", {
              threadId,
              transferId,
              path: exported.path,
            }),
          ).toEqual(imported);
          expect((await rpc("thread/queue/list", { threadId })).data).toEqual([
            queued.queuedSubmission,
          ]);
          const resumed = await rpc("thread/resume", {
            threadId,
            path: imported.path,
            modelProvider: "fixture-b",
            model: "gpt-5",
            managedConfig,
          });
          expect(resumed.thread.id).toBe(threadId);
          expect(resumed.modelProvider).toBe("fixture-b");
          expect(resumed.sandbox).toEqual(initial.sandbox);
          expect(resumed.approvalPolicy).toEqual(initial.approvalPolicy);
          expect(resumed.reasoningEffort).toEqual(initial.reasoningEffort);
          expect(resumed.serviceTier).toEqual(initial.serviceTier);
          expect(await rpc("thread/goal/get", { threadId })).toEqual(
            sourceGoal,
          );
          expect(
            (await rpc("project/read", { projectId: project.id })).project,
          ).toMatchObject({
            id: project.id,
            name: project.name,
            roots: project.roots,
            metadata: project.metadata,
          });
          expect((await rpc("threadSection/list", {})).data).toContainEqual(
            section,
          );
          const targetTransfer = await rpc("thread/managedHistory/export", {
            threadId,
            transferId: randomUUID(),
            expectedLastTurnId: firstTurnId,
          });
          expect(
            JSON.parse(await readFile(targetTransfer.path, "utf8")).state,
          ).toMatchObject({
            memory_mode: "disabled",
            goal: sourceTransfer.state.goal,
          });
          await expect(
            rpc("thread/managedHistory/import", {
              threadId,
              transferId,
              path: exported.path,
            }),
          ).rejects.toThrow("migration destination is already loaded");

          expect(
            (await readCodexNativeHistory(rpc, threadId)).thread.turns,
          ).toEqual(source.thread.turns);
          const secondTurnId = await turn(threadId, "AFTER_MIGRATION");
          expect(requests.map((request) => request.url)).toEqual([
            "/a/v1/responses",
            "/b/v1/responses",
          ]);
          expect(JSON.stringify(requests[1]!.body.input)).toContain(
            "BEFORE_MIGRATION",
          );
          expect(JSON.stringify(requests[1]!.body.input)).toContain(
            "AFTER_MIGRATION",
          );
          const destinationHistory = await readCodexNativeHistory(
            rpc,
            threadId,
          );
          await rpc("thread/goal/clear", { threadId });
          await rpc("thread/memoryMode/set", { threadId, mode: "enabled" });
          await rpc("thread/queue/delete", {
            threadId,
            queuedSubmissionId: queued.queuedSubmission.id,
          });
          expect((await rpc("thread/queue/list", { threadId })).data).toEqual(
            [],
          );
          const returnId = randomUUID();
          const returnExport = await rpc("thread/managedHistory/export", {
            threadId,
            transferId: returnId,
            expectedLastTurnId: secondTurnId,
          });
          expect(
            JSON.parse(await readFile(returnExport.path, "utf8")).state,
          ).toMatchObject({
            memory_mode: "enabled",
            goal: null,
          });
          await stop();
          // A cold runtime reads the imported native history without another import.
          await start("b");
          expect(
            (await readCodexNativeHistory(rpc, threadId)).thread.turns,
          ).toEqual(destinationHistory.thread.turns);
          expect((await rpc("thread/queue/list", { threadId })).data).toEqual(
            [],
          );
          // Retry of a completed old import must not roll back newer history or
          // resurrect input that the destination has already removed.
          expect(
            await rpc("thread/managedHistory/import", {
              threadId,
              transferId,
              path: exported.path,
            }),
          ).toEqual(imported);
          expect(
            (await readCodexNativeHistory(rpc, threadId)).thread.turns,
          ).toEqual(destinationHistory.thread.turns);
          expect((await rpc("thread/goal/get", { threadId })).goal).toBeNull();
          // Export requires a loaded engine. Inspect the persisted fixture row
          // directly here so a resume cannot obscure an old-import regression.
          const coldState = new DatabaseSync(
            path.join(directory, "b", "state_5.sqlite"),
            { readOnly: true },
          );
          try {
            expect(
              coldState
                .prepare("SELECT memory_mode FROM threads WHERE id = ?")
                .get(threadId),
            ).toEqual({ memory_mode: "enabled" });
          } finally {
            coldState.close();
          }
          expect((await rpc("thread/queue/list", { threadId })).data).toEqual(
            [],
          );

          await stop();
          // Source ownership/history remain intact until the future handoff controller commits.
          await start("a");
          expect(await rpc("thread/goal/get", { threadId })).toEqual(
            sourceGoal,
          );
          await expect(
            rpc("thread/managedHistory/import", {
              threadId,
              transferId: returnId,
              path: returnExport.path,
            }),
          ).rejects.toThrow(
            "migration destination conversation already exists",
          );
          expect(
            (await readCodexNativeHistory(rpc, threadId)).thread.turns,
          ).toEqual(source.thread.turns);
          await stop();
          // Returning to the original provider uses a fresh destination namespace,
          // avoiding any overwrite of the source account's retained conversation.
          await start("a", "return-a");
          const returned = await rpc("thread/managedHistory/import", {
            threadId,
            transferId: returnId,
            path: returnExport.path,
          });
          await rpc("thread/resume", {
            threadId,
            path: returned.path,
            modelProvider: "fixture-a",
            model: "gpt-5",
            managedConfig,
          });
          expect(
            (await readCodexNativeHistory(rpc, threadId)).thread.turns,
          ).toEqual(destinationHistory.thread.turns);
          await turn(threadId, "RETURNED_TO_A");
          expect(requests.at(-1)!.url).toBe("/a/v1/responses");
          expect(JSON.stringify(requests.at(-1)!.body.input)).toContain(
            "AFTER_MIGRATION",
          );
          await stop();
          await start("b", "empty-b");
          const requestCount = requests.length;
          const emptyImported = await rpc("thread/managedHistory/import", {
            threadId,
            transferId: emptyTransferId,
            path: emptyExport.path,
          });
          const emptyResumed = await rpc("thread/resume", {
            threadId,
            path: emptyImported.path,
            modelProvider: "fixture-b",
            model: "gpt-5",
            managedConfig,
          });
          expect(emptyResumed.sandbox).toEqual(initial.sandbox);
          expect(emptyResumed.approvalPolicy).toEqual(initial.approvalPolicy);
          expect(emptyResumed.reasoningEffort).toEqual(initial.reasoningEffort);
          expect(emptyResumed.serviceTier).toEqual(initial.serviceTier);
          expect(
            (await readCodexNativeHistory(rpc, threadId)).thread.turns,
          ).toEqual([]);
          expect(requests).toHaveLength(requestCount);
          // Export must check real native activity even with a valid previous
          // turn boundary. Hold the actual provider response to keep it active.
          holdResponse = true;
          const active = await rpc("turn/start", {
            threadId,
            input: [{ type: "text", text: "ACTIVE_MIGRATION_REJECTION" }],
          });
          await expect.poll(() => releaseResponse).toBeDefined();
          await expect(
            rpc("thread/managedHistory/export", {
              threadId,
              transferId: randomUUID(),
              expectedLastTurnId: null,
            }),
          ).rejects.toThrow("cannot migrate history during an active turn");
          releaseResponse!();
          await client!.waitForNotification(
            "turn/completed",
            (params: any) => params?.turn?.id === active.turn.id,
          );
          expect(declinedAttempts.length).toBeGreaterThan(0);
          expect(admissionErrors).toEqual([]);
        } finally {
          releaseResponse?.();
          await stop();
          provider.closeAllConnections();
          await new Promise<void>((resolve) => provider.close(() => resolve()));
          await rm(directory, { recursive: true, force: true });
        }
      },
      120000,
    );
  },
);

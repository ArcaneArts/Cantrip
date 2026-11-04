import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { CodexRpcClient } from "../src/codex/rpc-client.js";
import { verifyBuiltRuntime } from "../../scripts/cantrip-codex/verify-built-runtime.mjs";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
type Json = Record<string, any>;
const execute = promisify(execFile);

function incompatibleCheckpoint(original: Buffer) {
  const envelope = JSON.parse(original.toString());
  const record = JSON.parse(envelope.recordJson);
  record.runtimeVersion = "incompatible-native-runtime/continuation-v99";
  record.continuation = { unknownFutureContinuation: true };
  envelope.recordJson = JSON.stringify(record);
  envelope.sha256 = createHash("sha256")
    .update(envelope.recordJson)
    .digest("hex");
  return Buffer.from(JSON.stringify(envelope));
}

/** Kill the actual isolated native tree, including separately grouped helpers.
 * This does not send graceful shutdown or fabricate a suspended rollout. */
async function killNativeTree(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  if (process.platform === "win32") {
    await execute("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  } else {
    const { stdout } = await execute("ps", ["-axo", "pid=,ppid="]);
    const rows = stdout
      .trim()
      .split("\n")
      .map((row) => row.trim().split(/\s+/).map(Number));
    const owned = new Set<number>([child.pid!]);
    for (;;) {
      const before = owned.size;
      for (const [pid, parent] of rows) if (owned.has(parent!)) owned.add(pid!);
      if (owned.size === before) break;
    }
    // Stop the root first so its supervisors cannot restart known descendants.
    for (const pid of owned) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
  await closed;
}

function stream(response: ServerResponse, events: Json[]) {
  for (const event of events)
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

function completed(id: string) {
  return {
    type: "response.completed",
    response: {
      id,
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    },
  };
}

function answer(response: ServerResponse, id: string, text: string) {
  stream(response, [
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id,
        phase: "final_answer",
        content: [{ type: "output_text", text }],
      },
    },
    completed(`${id}-response`),
  ]);
}

function tool(request: Json, command: string, id: string) {
  const tools = request.tools.flatMap((entry: Json) =>
    entry.type === "namespace"
      ? entry.tools.map((item: Json) => ({ ...item, namespace: entry.name }))
      : [entry],
  );
  const selected = tools.find((entry: Json) => entry.name === "exec_command");
  expect(
    selected,
    "native exec_command must actually be advertised",
  ).toBeDefined();
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      id: `item-${id}`,
      call_id: id,
      name: selected.name,
      ...(selected.namespace ? { namespace: selected.namespace } : {}),
      arguments: JSON.stringify({ cmd: command, yield_time_ms: 10000 }),
    },
  };
}

describe.skipIf(!binary)(
  "durable suspension on the real pinned native runtime",
  () => {
    it.each(["paginated", "legacy"] as const)(
      "keeps one native turn and completed tool results through forced process-tree termination with %s history",
      async (historyMode) => {
        // Inspect the exact packaged executable and current patch fingerprint.
        await verifyBuiltRuntime(path.dirname(binary!));
        const directory = await mkdtemp(
          path.join(tmpdir(), "cantrip-durable-native-"),
        );
        const home = path.join(directory, "home"),
          cwd = path.join(directory, "workspace");
        const requests: { body: Json; response: ServerResponse }[] = [];
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
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `native-${requests.length}` } })}\n\n`,
          );
        });
        let child: ChildProcessWithoutNullStreams | undefined,
          client: CodexRpcClient | undefined;
        let completedSuccessfully = false;
        let retirementPipe:
          | {
              path: string;
              original: Buffer;
              opening?: Promise<FileHandle>;
              writer?: FileHandle;
            }
          | undefined;
        let frames: Json[] = [];
        const allFrames: Json[][] = [];
        const nativeStderr: string[] = [];
        const rpc = async (method: string, params: Json): Promise<Json> => {
          const response = await client!.request(method, params);
          if (response.error)
            throw new Error(`${method}: ${JSON.stringify(response.error)}`);
          return response.result as Json;
        };
        const start = async () => {
          child = spawn(binary!, ["app-server"], {
            cwd,
            env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
            stdio: "pipe",
          });
          child.stderr.on("data", (chunk) => nativeStderr.push(String(chunk)));
          frames = [];
          allFrames.push(frames);
          const ownFrames = frames;
          readline
            .createInterface({ input: child.stdout })
            .on("line", (line) => ownFrames.push(JSON.parse(line)));
          client = new CodexRpcClient(child, 30000);
          await rpc("initialize", {
            clientInfo: { name: "cantrip_durable_native", version: "1" },
            capabilities: { experimentalApi: true },
          });
          client.notify("initialized");
        };
        const kill = async () => {
          if (child) await killNativeTree(child);
          client?.close();
          child = undefined;
          client = undefined;
        };
        try {
          await Promise.all([mkdir(home), mkdir(cwd)]);
          provider.listen(0, "127.0.0.1");
          await once(provider, "listening");
          await writeFile(
            path.join(home, "config.toml"),
            [
              'model="gpt-5"',
              'model_provider="fixture"',
              'approval_policy="never"',
              'sandbox_mode="danger-full-access"',
              "features.plugins=false",
              "features.code_mode_host=false",
              "[model_providers.fixture]",
              'name="Fixture"',
              `base_url="http://127.0.0.1:${(provider.address() as { port: number }).port}/v1"`,
              'wire_api="responses"',
              "requires_openai_auth=false",
              "request_max_retries=0",
              "stream_max_retries=0",
              "",
            ].join("\n"),
          );
          await start();
          const { thread } = await rpc("thread/start", { cwd, historyMode });
          const threadId = thread.id;
          const first = await rpc("turn/start", {
            threadId,
            input: [{ type: "text", text: "ORIGINAL_DURABLE_REQUEST" }],
            effort: "low",
            summary: "concise",
          });
          const turnId = first.turn.id;
          const checkpointFile = path.join(
            home,
            "turn-suspensions",
            `${createHash("sha256").update(threadId).digest("hex")}.json`,
          );
          const modes = ["cold", "live", "cold"] as const;
          const checkpointSnapshots: Buffer[] = [];
          const steers = [
            "ACCEPTED_DURABLE_STEER",
            "LIVE_DURABLE_STEER",
            "COLD_DURABLE_STEER",
          ];
          for (let cycle = 0; cycle < modes.length; cycle++) {
            await vi.waitFor(() => expect(requests).toHaveLength(cycle + 1), {
              timeout: 15000,
            });
            const checkpoints = path.join(home, "turn-suspensions");
            if (cycle === 0) {
              // An actual filesystem operation will fail while this is a file.
              // No permissions/readiness heuristic substitutes for the write.
              await writeFile(
                checkpoints,
                "injected checkpoint write failure",
                { flag: "wx" },
              );
            }
            const pause = rpc("turn/suspension", {
              threadId,
              operation: { type: "pause", turnId },
            });
            const response = requests[cycle]!;
            const release = `release-${cycle}`;
            const command =
              process.platform === "win32"
                ? `Add-Content -Path durable-counter.txt -Value 'cycle-${cycle}'; while (!(Test-Path '${release}')) { Start-Sleep -Milliseconds 25 }`
                : `printf 'cycle-${cycle}\\n' >> durable-counter.txt; while [ ! -f '${release}' ]; do sleep 0.02; done`;
            stream(response.response, [
              tool(response.body, command, `durable-tool-${cycle}`),
              completed(`tool-response-${cycle}`),
            ]);
            // Accept steering while a real tool is held, after the provider stream
            // finished. InstantInterrupt may otherwise cancel that stream before
            // its tool request ever becomes accepted native work.
            void pause.catch(() => undefined);
            await vi.waitFor(
              async () => {
                expect(
                  await readFile(path.join(cwd, "durable-counter.txt"), "utf8"),
                ).toContain(`cycle-${cycle}`);
              },
              { timeout: 15000 },
            );
            await rpc("turn/steer", {
              threadId,
              expectedTurnId: turnId,
              input: [
                {
                  type: "text",
                  text: steers[cycle]!,
                },
              ],
            });
            if (cycle === 0) {
              // Future defaults may change while this turn retains its captured
              // model and settings. Read actual application, not just admission.
              await rpc("thread/settings/update", {
                threadId,
                model: "gpt-5.1",
              });
              await vi.waitFor(
                async () => {
                  expect(
                    (await rpc("thread/settings/read", { threadId }))
                      .threadSettings.model,
                  ).toBe("gpt-5.1");
                },
                { timeout: 15000 },
              );
            }
            await writeFile(path.join(cwd, release), "released");
            let paused: Json;
            if (cycle === 0) {
              try {
                await expect(pause).rejects.toThrow(
                  /file|directory|path|os error|checkpoint/i,
                );
              } finally {
                await rm(checkpoints);
              }
              expect(requests).toHaveLength(cycle + 1);
              expect(
                frames.some((frame) => frame.method === "turn/completed"),
              ).toBe(false);
              expect(
                (
                  await rpc("turn/suspension", {
                    threadId,
                    operation: { type: "read" },
                  })
                ).suspension,
              ).toBeNull();
              // Retry from the same already-paused live boundary after repair.
              paused = await rpc("turn/suspension", {
                threadId,
                operation: { type: "pause", turnId },
              });
            } else {
              paused = await pause;
            }
            expect(paused.paused).toBe(true);
            expect(paused.suspension).toMatchObject({ threadId, turnId });
            // No grace delay or history read after durable acknowledgement.
            if (modes[cycle] === "cold") await kill();
            checkpointSnapshots.push(await readFile(checkpointFile));
            const counter = await readFile(
              path.join(cwd, "durable-counter.txt"),
              "utf8",
            );
            expect(counter.trim().split(/\r?\n/)).toEqual(
              Array.from({ length: cycle + 1 }, (_, index) => `cycle-${index}`),
            );
            expect(requests).toHaveLength(cycle + 1);
            if (modes[cycle] === "cold") {
              await start();
              // Inspect the actual committed continuation before any native
              // session exists. Repeated reads must not attach or prewarm it.
              for (let read = 0; read < 2; read++) {
                expect(
                  await rpc("turn/suspension", {
                    threadId,
                    operation: { type: "read" },
                  }),
                ).toMatchObject({
                  paused: true,
                  suspension: paused.suspension,
                });
                expect(
                  (await rpc("thread/loaded/list", {})).data,
                ).not.toContain(threadId);
              }
              await new Promise((resolve) => setTimeout(resolve, 200));
              expect(requests).toHaveLength(cycle + 1);
              const original = await readFile(checkpointFile);
              if (cycle > 0) {
                // An old checkpoint still names this same unfinished turn, but
                // completed work after its boundary makes it stale.
                await writeFile(checkpointFile, checkpointSnapshots[0]!);
                await expect(
                  rpc("turn/suspension", {
                    threadId,
                    operation: { type: "read" },
                  }),
                ).rejects.toThrow(
                  /history.*(advanced|changed)|execution.*advanced/i,
                );
                expect(await readFile(checkpointFile)).toEqual(
                  checkpointSnapshots[0],
                );
                expect(
                  (await rpc("thread/loaded/list", {})).data,
                ).not.toContain(threadId);
                await writeFile(checkpointFile, original);
              }
              if (cycle === 0) await rm(checkpointFile);
              else await writeFile(checkpointFile, "{corrupt checkpoint");
              // The saved intent must hold attachment even if data disappears
              // after a successful stored inspection. No preflight read can
              // substitute for this hold at native startup.
              await rpc("thread/resume", {
                threadId,
                expectedSuspension: paused.suspension,
              });
              for (const damage of cycle === 0
                ? [null]
                : [
                    Buffer.from("{corrupt checkpoint"),
                    incompatibleCheckpoint(original),
                  ]) {
                if (damage) await writeFile(checkpointFile, damage);
                const reason =
                  cycle === 0
                    ? /missing/i
                    : damage?.equals(Buffer.from("{corrupt checkpoint"))
                      ? /corrupt/i
                      : /runtime version is unsupported.*incompatible-native-runtime/i;
                await expect(
                  rpc("turn/suspension", {
                    threadId,
                    operation: { type: "read" },
                  }),
                ).rejects.toThrow(reason);
                await expect(
                  rpc("turn/suspension", {
                    threadId,
                    operation: {
                      type: "resume",
                      suspension: paused.suspension,
                    },
                  }),
                ).rejects.toThrow(reason);
                await expect(
                  rpc("turn/start", {
                    threadId,
                    input: [
                      { type: "text", text: "MUST_NOT_REPLACE_SUSPENDED_TURN" },
                    ],
                  }),
                ).rejects.toThrow(/paused|suspend/i);
                if (damage)
                  expect(await readFile(checkpointFile)).toEqual(damage);
                await new Promise((resolve) => setTimeout(resolve, 200));
                expect(requests).toHaveLength(cycle + 1);
              }
              await writeFile(checkpointFile, original);
            } else {
              await rpc("thread/resume", {
                threadId,
                expectedSuspension: paused.suspension,
              });
            }
            const observed = await rpc("turn/suspension", {
              threadId,
              operation: { type: "read" },
            });
            expect(observed).toMatchObject({
              paused: true,
              suspension: paused.suspension,
            });
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(requests).toHaveLength(cycle + 1);
            expect(
              frames.filter((frame) => frame.method === "turn/started"),
            ).toHaveLength(0);
            if (modes[cycle] === "live") {
              const held = `${checkpoints}-held`;
              await rename(checkpoints, held);
              try {
                await writeFile(
                  checkpoints,
                  "injected checkpoint settlement failure",
                  { flag: "wx" },
                );
                // Exercise the legacy UI/TUI control too. It must return the
                // real I/O error and preserve the actual paused native task.
                await expect(
                  rpc("turn/pause", { threadId, turnId, paused: false }),
                ).rejects.toThrow(/file|directory|path|os error|checkpoint/i);
                expect(requests).toHaveLength(cycle + 1);
                expect(
                  frames.some((frame) => frame.method === "turn/completed"),
                ).toBe(false);
              } finally {
                await rm(checkpoints, { force: true });
                await rename(held, checkpoints);
              }
              expect(
                await rpc("turn/suspension", {
                  threadId,
                  operation: { type: "read" },
                }),
              ).toMatchObject(observed);
              await new Promise((resolve) => setTimeout(resolve, 200));
              expect(requests).toHaveLength(cycle + 1);
            }
            const resumes = await Promise.allSettled(
              Array.from({ length: 2 }, () =>
                rpc("turn/suspension", {
                  threadId,
                  operation: {
                    type: "resume",
                    suspension: observed.suspension,
                  },
                }),
              ),
            );
            const accepted = resumes.filter(
              (result) => result.status === "fulfilled",
            );
            expect(accepted.length).toBeGreaterThanOrEqual(1);
            for (const result of accepted)
              expect(result.value.paused).toBe(false);
            for (const result of resumes)
              if (result.status === "rejected") {
                expect(String(result.reason)).toMatch(
                  /already|not resumed|checkpoint|no longer suspended|suspension identity/i,
                );
              }
            await vi.waitFor(() => expect(requests).toHaveLength(cycle + 2), {
              timeout: 15000,
            });
            await expect(
              rpc("thread/resume", {
                threadId,
                expectedSuspension: observed.suspension,
              }),
            ).rejects.toThrow(/running|suspend/i);
            expect(
              (
                await rpc("turn/suspension", {
                  threadId,
                  operation: { type: "read" },
                })
              ).suspension,
            ).toBeNull();
            const modelInput = JSON.stringify(requests[cycle + 1]!.body.input);
            expect(modelInput.match(/ORIGINAL_DURABLE_REQUEST/g)).toHaveLength(
              1,
            );
            for (const steer of steers.slice(0, cycle + 1)) {
              expect(modelInput.split(steer).length - 1).toBe(1);
            }
            expect(requests[cycle + 1]!.body.model).toBe(
              requests[0]!.body.model,
            );
            expect(requests[cycle + 1]!.body.reasoning).toEqual(
              requests[0]!.body.reasoning,
            );
            expect(requests[cycle + 1]!.body.reasoning).toMatchObject({
              effort: "low",
              summary: "concise",
            });
            for (let toolIndex = 0; toolIndex <= cycle; toolIndex++)
              expect(modelInput).toContain(`durable-tool-${toolIndex}`);
            expect(
              await readFile(path.join(cwd, "durable-counter.txt"), "utf8"),
            ).toBe(counter);
          }
          expect(requests).toHaveLength(modes.length + 1);
          expect(
            (
              await rpc("turn/suspension", {
                threadId,
                operation: { type: "read" },
              })
            ).suspension,
          ).toBeNull();
          if (process.platform !== "win32") {
            retirementPipe = {
              path: checkpointFile,
              original: await readFile(checkpointFile),
            };
            await rm(checkpointFile);
            await execute("mkfifo", ["-m", "600", checkpointFile]);
            // The writer-open handshake proves the old turn's real checkpoint
            // read has started. Keep it blocked while a later turn pauses.
            retirementPipe.opening = open(checkpointFile, "w");
          }
          answer(
            requests[modes.length]!.response,
            "durable-final",
            "RESUMED_ORIGINAL_TURN",
          );
          await vi.waitFor(
            () =>
              expect(
                frames.find(
                  (frame) =>
                    frame.method === "turn/completed" &&
                    frame.params.turn.id === turnId,
                )?.params.turn.status,
              ).toBe("completed"),
            { timeout: 15000 },
          );
          if (retirementPipe)
            retirementPipe.writer = await retirementPipe.opening;
          const history = await rpc("thread/read", {
            threadId,
            includeTurns: true,
          });
          expect(history.thread.turns).toHaveLength(1);
          expect(history.thread.turns[0]).toMatchObject({
            id: turnId,
            status: "completed",
          });
          expect(
            frames
              .filter(
                (frame) =>
                  frame.method === "thread/tokenUsage/updated" &&
                  frame.params.turnId === turnId,
              )
              .at(-1)?.params.tokenUsage.total,
          ).toMatchObject({
            inputTokens: 40,
            outputTokens: 12,
            totalTokens: 52,
          });
          const items = history.thread.turns[0].items as Json[];
          expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
          const recorded = JSON.stringify(items);
          for (const input of ["ORIGINAL_DURABLE_REQUEST", ...steers]) {
            expect(recorded.split(input).length - 1).toBe(1);
          }
          expect(
            allFrames.flat().filter((frame) => frame.method === "turn/started"),
          ).toHaveLength(1);
          if (!retirementPipe)
            expect(
              (
                await rpc("turn/suspension", {
                  threadId,
                  operation: { type: "read" },
                })
              ).suspension,
            ).toBeNull();
          expect(
            (await rpc("thread/settings/read", { threadId })).threadSettings
              .model,
          ).toBe("gpt-5.1");
          const next = await rpc("turn/start", {
            threadId,
            input: [{ type: "text", text: "NEXT_NORMAL_TURN" }],
          });
          expect(next.turn.id).not.toBe(turnId);
          await vi.waitFor(
            () => expect(requests).toHaveLength(modes.length + 2),
            { timeout: 15000 },
          );
          expect(requests[modes.length + 1]!.body.model).toBe("gpt-5.1");
          if (retirementPipe) {
            const racingPause = rpc("turn/suspension", {
              threadId,
              operation: { type: "pause", turnId: next.turn.id },
            });
            void racingPause.catch(() => undefined);
            stream(requests[modes.length + 1]!.response, [
              tool(
                requests[modes.length + 1]!.body,
                "printf 'done\\n' >> retirement-counter.txt",
                "retirement-tool",
              ),
              completed("retirement-tool-response"),
            ]);
            await vi.waitFor(
              async () =>
                expect(
                  await readFile(
                    path.join(cwd, "retirement-counter.txt"),
                    "utf8",
                  ),
                ).toBe("done\n"),
              { timeout: 15000 },
            );
            const accepted: string[] = [];
            await vi.waitFor(
              async () => {
                const text = `RETIREMENT_PENDING_STEER_${accepted.length}`;
                const response = await client!.request("turn/steer", {
                  threadId,
                  expectedTurnId: next.turn.id,
                  input: [{ type: "text", text }],
                });
                if (!response.error) {
                  accepted.push(text);
                  throw new Error(
                    "the later turn has not frozen its boundary yet",
                  );
                }
                expect(JSON.stringify(response.error)).toMatch(
                  // App Server maps native NotIdle from the frozen gate to
                  // this same error as an absent active turn.
                  /paused|suspend|not.?idle|no active turn to steer/i,
                );
              },
              { timeout: 15000 },
            );
            // Replace the pathname before releasing EOF. The old read still
            // owns its FIFO inode; the later capture reads the regular file.
            await rm(checkpointFile);
            await writeFile(checkpointFile, retirementPipe.original, {
              mode: 0o600,
              flag: "wx",
            });
            await retirementPipe.writer!.writeFile(retirementPipe.original);
            await retirementPipe.writer!.close();
            retirementPipe = undefined;
            const raced = await racingPause;
            expect(raced.suspension.turnId).toBe(next.turn.id);
            const frozenInput = await client!.request("turn/steer", {
              threadId,
              expectedTurnId: next.turn.id,
              input: [{ type: "text", text: "AFTER_RETIREMENT_MUST_REJECT" }],
            });
            expect(frozenInput.error).toBeDefined();
            await rpc("turn/suspension", {
              threadId,
              operation: { type: "resume", suspension: raced.suspension },
            });
            await vi.waitFor(
              () => expect(requests).toHaveLength(modes.length + 3),
              { timeout: 15000 },
            );
            const input = JSON.stringify(requests.at(-1)!.body.input);
            for (const text of accepted)
              expect(input.split(text).length - 1).toBe(1);
            expect(
              await readFile(path.join(cwd, "retirement-counter.txt"), "utf8"),
            ).toBe("done\n");
          }
          answer(
            requests.at(-1)!.response,
            "next-final",
            "NEXT_TURN_COMPLETED",
          );
          await vi.waitFor(
            () =>
              expect(
                frames.find(
                  (frame) =>
                    frame.method === "turn/completed" &&
                    frame.params.turn.id === next.turn.id,
                )?.params.turn.status,
              ).toBe("completed"),
            { timeout: 15000 },
          );
          expect(
            allFrames.flat().filter((frame) => frame.method === "turn/started"),
          ).toHaveLength(2);

          let starts = 2;
          for (const stopMode of ["live", "corrupt", "incompatible"] as const) {
            const requestIndex = requests.length;
            const counterName = `stopped-${stopMode}.txt`;
            const stopped = await rpc("turn/start", {
              threadId,
              input: [{ type: "text", text: `STOP_DURABLE_TURN_${stopMode}` }],
            });
            await vi.waitFor(
              () => expect(requests).toHaveLength(requestIndex + 1),
              { timeout: 15000 },
            );
            const stoppingPause = rpc("turn/suspension", {
              threadId,
              operation: { type: "pause", turnId: stopped.turn.id },
            });
            stream(requests[requestIndex]!.response, [
              tool(
                requests[requestIndex]!.body,
                process.platform === "win32"
                  ? `Add-Content -Path ${counterName} -Value 'done'`
                  : `printf 'done\\n' >> ${counterName}`,
                `stopped-tool-${stopMode}`,
              ),
              completed(`stopped-tool-response-${stopMode}`),
            ]);
            const stopCheckpoint = await stoppingPause;
            expect(stopCheckpoint.suspension.turnId).toBe(stopped.turn.id);
            let damaged: Buffer | undefined;
            if (stopMode !== "live") {
              await kill();
              const original = await readFile(checkpointFile);
              damaged =
                stopMode === "corrupt"
                  ? Buffer.from("{keep these corrupt checkpoint bytes")
                  : incompatibleCheckpoint(original);
              await writeFile(checkpointFile, damaged);
              await start();
              await rpc("thread/resume", {
                threadId,
                expectedSuspension: stopCheckpoint.suspension,
              });
              await expect(
                rpc("turn/suspension", {
                  threadId,
                  operation: { type: "read" },
                }),
              ).rejects.toThrow(/corrupt|unsupported/i);
              expect(await readFile(checkpointFile)).toEqual(damaged);
              expect(requests).toHaveLength(requestIndex + 1);
            }
            for (let attempt = 0; attempt < 2; attempt++) {
              expect(
                await rpc("turn/suspension", {
                  threadId,
                  operation: { type: "discard", turnId: stopped.turn.id },
                }),
              ).toMatchObject({ paused: false, suspension: null });
              await vi.waitFor(
                () =>
                  expect(
                    frames.filter(
                      (frame) =>
                        frame.method === "turn/completed" &&
                        frame.params.turn.id === stopped.turn.id,
                    ),
                  ).toHaveLength(1),
                { timeout: 15000 },
              );
            }
            if (damaged) {
              const prefix =
                path.basename(checkpointFile, ".json") + ".retired-";
              const retained = await Promise.all(
                (await readdir(path.dirname(checkpointFile)))
                  .filter((name) => name.startsWith(prefix))
                  .map((name) =>
                    readFile(path.join(path.dirname(checkpointFile), name)),
                  ),
              );
              expect(retained.some((bytes) => bytes.equals(damaged!))).toBe(
                true,
              );
            }
            await kill();
            await start();
            await rpc("thread/resume", { threadId });
            expect(
              (
                await rpc("turn/suspension", {
                  threadId,
                  operation: { type: "read" },
                })
              ).suspension,
            ).toBeNull();
            await expect(
              rpc("turn/suspension", {
                threadId,
                operation: {
                  type: "resume",
                  suspension: stopCheckpoint.suspension,
                },
              }),
            ).rejects.toThrow(/ended|no longer|identity|suspended|missing/i);
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(requests).toHaveLength(requestIndex + 1);
            const afterStop = await rpc("turn/start", {
              threadId,
              input: [
                { type: "text", text: `NORMAL_TURN_AFTER_STOP_${stopMode}` },
              ],
            });
            expect(afterStop.turn.id).not.toBe(stopped.turn.id);
            await vi.waitFor(
              () => expect(requests).toHaveLength(requestIndex + 2),
              { timeout: 15000 },
            );
            answer(
              requests[requestIndex + 1]!.response,
              `after-stop-final-${stopMode}`,
              "NORMAL_TURN_AFTER_STOP_COMPLETED",
            );
            await vi.waitFor(
              () =>
                expect(
                  frames.find(
                    (frame) =>
                      frame.method === "turn/completed" &&
                      frame.params.turn.id === afterStop.turn.id,
                  )?.params.turn.status,
                ).toBe("completed"),
              { timeout: 15000 },
            );
            expect(await readFile(path.join(cwd, counterName), "utf8")).toMatch(
              /^done\r?\n$/,
            );
            starts += 2;
            expect(
              allFrames
                .flat()
                .filter((frame) => frame.method === "turn/started"),
            ).toHaveLength(starts);
          }
          completedSuccessfully = true;
        } finally {
          requests.forEach(({ response }) => response.destroy());
          if (retirementPipe) {
            // Unblock an outstanding writer-open even when a failing native
            // cleanup never reached its read; do not leak a libuv operation.
            const reader = await open(
              retirementPipe.path,
              constants.O_RDONLY | constants.O_NONBLOCK,
            ).catch(() => undefined);
            const writer =
              retirementPipe.writer ??
              (await retirementPipe.opening?.catch(() => undefined));
            await writer?.close().catch(() => undefined);
            await reader?.close().catch(() => undefined);
          }
          await kill();
          provider.closeAllConnections();
          await new Promise<void>((resolve) => provider.close(() => resolve()));
          if (completedSuccessfully)
            await rm(directory, { recursive: true, force: true });
          else {
            await Promise.all([
              writeFile(
                path.join(directory, "native-stderr.log"),
                nativeStderr.join(""),
              ),
              writeFile(
                path.join(directory, "rpc-frames.json"),
                JSON.stringify(allFrames, null, 2),
              ),
              writeFile(
                path.join(directory, "provider-requests.json"),
                JSON.stringify(
                  requests.map(({ body }) => body),
                  null,
                  2,
                ),
              ),
            ]);
            console.error(
              `Retained failed native suspension fixture: ${directory}`,
            );
          }
        }
      },
      120000,
    );
  },
);

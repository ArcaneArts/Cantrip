import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  CodexAppServer,
  type CodexProcessLauncher,
} from "../src/codex/app-server.js";
import { discoverCodexRuntime } from "../src/codex/discovery.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
describe.skipIf(!binary)("native managed account configuration", () => {
  it.each(["account", "conversation"])(
    "keeps shared defaults canonical with history in the %s home",
    async (storage) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "cantrip-account-config-"),
      );
      const account = path.join(directory, "account");
      const home = path.join(directory, storage);
      const cwd = path.join(directory, "workspace");
      const requests: string[] = [];
      const server = createServer((req, res) => {
        requests.push(req.url ?? "");
        res.writeHead(500).end("This fixture must not request inference.");
      });
      let runtime: CodexAppServer | undefined;
      let child: ChildProcessWithoutNullStreams | undefined;
      let closed: Promise<unknown> | undefined;
      const launch: CodexProcessLauncher = (file, args, options) => {
        child = spawn(file, args, {
          ...options,
          env: { ...options.env, HOME: directory },
          stdio: "pipe",
        });
        closed = once(child, "close");
        return child;
      };
      const close = async () => {
        if (!runtime) return;
        const native = child;
        const force = setTimeout(() => native?.kill("SIGKILL"), 5000);
        runtime.close();
        await closed;
        clearTimeout(force);
        runtime = undefined;
      };
      try {
        await Promise.all([mkdir(account), mkdir(cwd)]);
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const configPath = path.join(account, "config.toml");
        await writeFile(
          configPath,
          'model_reasoning_effort="low"\nservice_tier="priority"\nfeatures.plugins=false\n' +
            `[projects.${JSON.stringify(await realpath(cwd))}]\ntrust_level="trusted"\n`,
        );
        const initialConfig = await readFile(configPath, "utf8");
        const compatibility = await discoverCodexRuntime(
          binary!,
          path.join(directory, "probe"),
        );
        const model = {
          id: "model",
          routeId: "route",
          name: "gpt-5",
          reasoningEffort: null,
        };
        const provider = {
          id: "provider",
          name: "Local fixture",
          kind: "openai" as const,
          baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
          apiKey: "fixture-not-a-real-key",
        };
        const start = async () => {
          runtime = new CodexAppServer(
            binary!,
            path.join(directory, "runtime"),
            home,
            compatibility,
            undefined,
            undefined,
            undefined,
            launch,
            [],
            storage === "conversation" ? account : null,
          );
          await runtime.remoteEndpoint(model, provider);
          runtime.setManagedNativeCommandDispatcher(
            "no-thread-needed-for-defaults",
            (command) => command.dispatch(),
          );
        };
        await start();
        const readOptions = {
          threadId: "no-thread-needed-for-defaults",
          operationId: "read",
          settingsBindingId: "fixture",
        };
        const initial = await runtime!.nativeAccountDefaults(readOptions);
        expect(initial.snapshot?.stored).toMatchObject({
          model_reasoning_effort: "low",
          service_tier: "priority",
        });
        const prepared = await runtime!.prepareManagedThread({
          cwd,
          model,
          provider,
          threadId: null,
          permissionProfileId: ":workspace",
          executionProfile: "ide",
          subagentDefaults: null,
          planMode: "default",
          intent: "configure",
          mcpServers: [],
          canonicalHistory: true,
        });
        const beforeSettings = await runtime!.readNativeThreadSettings(
          prepared.threadId,
        );
        expect(beforeSettings.confirmed?.settings.model).toBe("gpt-5");
        await runtime!.prepareManagedThread({
          cwd,
          model,
          provider,
          threadId: prepared.threadId,
          permissionProfileId: ":workspace",
          executionProfile: "ide",
          subagentDefaults: null,
          planMode: "default",
          intent: "preserve",
          mcpServers: [],
          canonicalHistory: true,
        });
        expect(await readFile(configPath, "utf8")).toBe(initialConfig);
        // Admission behavior is covered separately; this fixture exercises the
        // real worker/native config read, write and cold storage boundary.
        runtime!.setManagedNativeCommandDispatcher(
          prepared.threadId,
          (command) => command.dispatch(),
        );
        const changed = await runtime!.nativeAccountDefaults({
          ...readOptions,
          threadId: prepared.threadId,
          operationId: "write",
          write: {
            expectedVersion: initial.snapshot!.version,
            values: { model_reasoning_effort: "high" },
          },
        });
        expect(changed.verification).toBe("confirmed");
        expect(changed.snapshot?.stored.model_reasoning_effort).toBe("high");
        expect(parseToml(await readFile(configPath, "utf8"))).toMatchObject({
          model_reasoning_effort: "high",
          service_tier: "priority",
        });
        expect(
          (await runtime!.readNativeThreadSettings(prepared.threadId)).confirmed
            ?.settings,
        ).toEqual(beforeSettings.confirmed?.settings);
        const exported = await runtime!.exportManagedHistory({
          threadId: prepared.threadId,
          transferId: randomUUID(),
          expectedLastTurnId: null,
        });
        expect(
          path
            .relative(await realpath(home), await realpath(exported.path))
            .startsWith(".."),
        ).toBe(false);
        await close();
        await start();
        expect(
          (await runtime!.nativeAccountDefaults(readOptions)).snapshot?.stored
            .model_reasoning_effort,
        ).toBe("high");
        expect(
          (await runtime!.readNativeHistory(prepared.threadId)).thread.id,
        ).toBe(prepared.threadId);
        if (storage === "conversation")
          await expect(
            stat(path.join(home, "config.toml")),
          ).rejects.toMatchObject({
            code: "ENOENT",
          });
        await expect(stat(path.join(home, "auth.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(requests).toEqual([]);
      } finally {
        await close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
    60000,
  );
});

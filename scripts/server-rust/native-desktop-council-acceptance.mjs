import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { chromium } from "playwright-core";
import { startEditorRecoveryFixture } from "../qa/editor-recovery-fixture.mjs";
import { eventually } from "./full-worker.mjs";
import { nativeDesktopBridge } from "./native-desktop-bridge.mjs";
import { taskModelProvider } from "./task-model-provider.mjs";

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    worker: { type: "string" },
    codex: { type: "string" },
    cli: { type: "string" },
    report: { type: "string" },
  },
});
assert.equal(process.platform, "darwin");
const project = fileURLToPath(new URL("../../", import.meta.url));
const appDirectory = path.join(project, "cantrip_app");
const tauri = createRequire(path.join(appDirectory, "package.json")).resolve(
  "@tauri-apps/cli/tauri.js",
);
const execute = promisify(execFile);
const tauriConfig = JSON.parse(
  await readFile(path.join(appDirectory, "src-tauri/tauri.conf.json"), "utf8"),
);
const bridge = await nativeDesktopBridge();
const model = await taskModelProvider({ observeStreams: true });
const report = { suite: "native-desktop-council-acceptance", stages: [] };
const original = { ...process.env };
const seedCouncil = {
  name: "isolated-native-council-seed",
  enforce: "pre",
  transform(source, id) {
    if (!id.replaceAll("\\", "/").endsWith("/cantrip_app/src/main.tsx"))
      return null;
    return {
      code:
        source +
        `
globalThis.__qaSeedCouncil = async ({ title, role, baseUrl, name }) => {
  const models = await import("@/lib/api/models");
  const provider = await models.createModelProvider({
    name: "Disposable native Council provider", kind: "openai-compatible", baseUrl, apiKey: null,
  });
  const profile = await models.createModelProfile({
    name: "Disposable native Council profile",
    routes: [{ providerId: provider.id, modelName: name, enabled: true }],
  });
  await (await import("@/lib/api/settings")).updateSettings({
    defaultCouncilModelId: profile.id, autoNameChats: false,
  });
  const { createCouncilAgent } = await import("@/lib/api/council");
  return (await createCouncilAgent(title, role)).id;
};
`,
      map: null,
    };
  },
};
let fixture, browser, launcher, appPid, exited, completion, logs, failure;
try {
  process.env.CANTRIP_DEVELOPMENT_KEY_VAULT = "1";
  process.env.CANTRIP_CODEX_BIN = path.resolve(values.codex);
  process.env.CANTRIP_CLI_BIN = path.resolve(values.cli);
  fixture = await startEditorRecoveryFixture({
    nativeLoopbackOrigin: true,
    serverExecutable: path.resolve(values.server),
    workerExecutable: path.resolve(values.worker),
    serverEnvironment: { CANTRIP_DATABASE_MODE: "pglite" },
    clientPlugins: [bridge.plugin, seedCouncil],
  });
  report.fixtureDirectory = fixture.directory;
  bridge.setClientOrigin(fixture.origin);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CANTRIP_TEST_BROWSER_BINARY || undefined,
  });
  const page = await browser.newPage({ acceptDownloads: true });
  await page.goto(fixture.origin);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Save recovery file", exact: true })
    .click();
  const recoveryPath = path.join(
    fixture.directory,
    "council-recovery-fixture.json",
  );
  await (await download).saveAs(recoveryPath);
  await page
    .getByRole("checkbox", {
      name: "I saved the recovery file somewhere I can access later.",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Continue to Cantrip", exact: true })
    .click();
  await fixture.inject({ type: "restart", process: "worker" });
  await eventually(
    () => fetch(`${fixture.origin}/api/workers/${fixture.workerId}/version`),
    (response) => assert.ok(response.ok),
    60_000,
  );

  // The fixture uses the production Settings and Council API against the same
  // disposable account that the native WebView opens with its recovery file.
  const title = "Native Release Council";
  const role = "Record the native release readiness evidence.";
  await page
    .getByRole("button", { name: /switch cantrip mode/iu })
    .first()
    .waitFor();
  const agentId = await page.evaluate(
    (input) => globalThis.__qaSeedCouncil(input),
    { title, role, baseUrl: model.baseUrl, name: model.model },
  );
  await browser.close();
  browser = undefined;
  report.stages.push(
    "disposable native Council account, Worker and model prepared",
  );

  const identifier =
    "art.cantrip.qa.workspace" + randomUUID().replaceAll("-", "");
  const config = {
    identifier,
    productName: "Cantrip Council QA",
    build: { beforeDevCommand: "", devUrl: fixture.origin },
    app: {
      windows: tauriConfig.app.windows.map((window) => ({
        ...window,
        focus: false,
        visible: false,
      })),
    },
  };
  const desktopData = path.join(fixture.directory, "desktop");
  await mkdir(desktopData);
  logs = createWriteStream(
    path.join(fixture.directory, "native-council-app.log"),
  );
  launcher = spawn(
    process.execPath,
    [
      tauri,
      "dev",
      "--no-watch",
      "--runner",
      path.join(project, "scripts/qa/workspace-native-runner.mjs"),
      "--config",
      JSON.stringify(config),
    ],
    {
      cwd: appDirectory,
      detached: true,
      env: {
        ...process.env,
        CANTRIP_QA_BUNDLE_ID: identifier,
        CANTRIP_QA_FIXTURE_DIR: fixture.directory,
        CANTRIP_QA_BACKGROUND: "true",
        CANTRIP_LOCAL_ONLY: "true",
        CANTRIP_SERVER_URL: fixture.origin,
        CANTRIP_WORKER_ID: fixture.workerId,
        CANTRIP_WORKER_DATA_DIR: path.join(fixture.directory, "worker"),
        CANTRIP_DESKTOP_DATA_DIR: desktopData,
        CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "4",
        CARGO_INCREMENTAL: "0",
        CARGO_PROFILE_DEV_DEBUG: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  launcher.stdout.pipe(logs, { end: false });
  launcher.stderr.pipe(logs, { end: false });
  createInterface({ input: launcher.stdout }).on("line", (line) => {
    if (!line.startsWith("QA_EVT ")) return;
    const event = JSON.parse(line.slice(7));
    if (event.event === "native.workspace.process") appPid = event.pid;
  });
  completion = new Promise((resolve) => {
    launcher.once("error", (error) => {
      exited = { error: error.message };
      resolve(exited);
    });
    launcher.once("close", (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    });
  });
  await eventually(
    () => {
      if (exited)
        throw new Error("Native launcher exited: " + JSON.stringify(exited));
      return appPid;
    },
    (pid) => assert.ok(pid),
    600_000,
  );
  const checkBackground = async () => {
    const { stdout } = await execute("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;',
    ]);
    assert.ok(Number(stdout.trim()) > 0);
    assert.notEqual(
      Number(stdout.trim()),
      appPid,
      "The native QA app stayed in the background",
    );
  };
  await checkBackground();
  const { evaluate, until } = bridge;
  await until("main", () =>
    Boolean(document.querySelector("input[type=file]")),
  );
  await evaluate(
    "main",
    (content) => {
      const input = document.querySelector("input[type=file]");
      const files = new DataTransfer();
      files.items.add(
        new File([content], "disposable-council-recovery.json", {
          type: "application/json",
        }),
      );
      input.files = files.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    await readFile(recoveryPath, "utf8"),
  );
  await until(
    "main",
    (title) => {
      const nav = document.querySelector('nav[aria-label="Council agents"]');
      if (nav) {
        const agent = [...nav.querySelectorAll("button")].find(
          (button) => button.textContent.trim() === title,
        );
        if (!agent) return false;
        agent.click();
        return true;
      }
      const menu = [...document.querySelectorAll('[role="menuitem"]')].find(
        (node) => node.textContent.trim() === "Cantrip Council",
      );
      if (menu) {
        menu.click();
      } else {
        document
          .querySelector('button[aria-label*="Switch Cantrip mode"]')
          ?.dispatchEvent(
            new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
          );
      }
      return false;
    },
    title,
  );
  const answer = "The native Council turn completed in the background.";
  const prompt = "Confirm the local native release is ready.";
  const reply = model.reply({ text: answer });
  await until("main", () =>
    Boolean(
      document.querySelector(
        'textarea[placeholder="Message Cantrip…"]:enabled',
      ),
    ),
  );
  await evaluate(
    "main",
    (text) => {
      const input = document.querySelector(
        'textarea[placeholder="Message Cantrip…"]:enabled',
      );
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      ).set.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    prompt,
  );
  await until("main", () => {
    const send = [...document.querySelectorAll("button")].find(
      (button) =>
        !button.disabled && button.textContent.includes("Send prompt"),
    );
    if (!send) return false;
    send.click();
    return true;
  });
  await until(
    "main",
    (text) =>
      document
        .querySelector('[data-slot="council-conversation"]')
        ?.textContent.includes(text),
    answer,
  );
  assert.ok(reply.request.completed);
  assert.ok(JSON.stringify(reply.request.input).includes(prompt));
  assert.ok(JSON.stringify(reply.request.input).includes(role));
  assert.deepEqual(model.failures, []);
  await checkBackground();
  report.agentId = agentId;
  report.stages.push(
    "hidden real macOS WebView opened Council and displayed an actual native Codex reply",
  );
} catch (error) {
  failure = error;
  report.failure = error.stack;
} finally {
  await browser?.close();
  if (launcher && !exited) {
    try {
      process.kill(appPid ?? -launcher.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    const timeout = setTimeout(() => {
      try {
        process.kill(-launcher.pid, "SIGKILL");
      } catch {}
    }, 15_000);
    report.launcherExit = await completion;
    clearTimeout(timeout);
  }
  logs?.end();
  await fixture?.close();
  await bridge.close();
  await model.close();
  for (const name of Object.keys(process.env))
    if (!(name in original)) delete process.env[name];
  Object.assign(process.env, original);
  await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(JSON.stringify(report));

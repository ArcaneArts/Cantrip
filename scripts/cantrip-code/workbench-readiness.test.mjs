import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { before, test } from "node:test";
import { stripTypeScriptTypes } from "node:module";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
let javascript;
before(async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantrip-readiness-"));
  const relative = "src/vs/workbench/browser/workbench.ts";
  try {
    await mkdir(path.dirname(path.join(directory, relative)), {
      recursive: true,
    });
    await writeFile(
      path.join(directory, relative),
      await readFile(path.join(root, "cantrip_code/upstream", relative)),
    );
    const applied = spawnSync(
      "git",
      [
        "apply",
        "--no-index",
        "--unsafe-paths",
        "--ignore-space-change",
        path.join(
          root,
          "cantrip_code/patches/0008-signal-embedded-workbench-readiness.patch",
        ),
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CEILING_DIRECTORIES: path.dirname(directory),
        },
      },
    );
    assert.equal(applied.status, 0, applied.stderr);
    const patched = await readFile(path.join(directory, relative), "utf8");
    const helper = patched.slice(
      patched.indexOf("const CANTRIP_FRAME_NONCE_PATTERN"),
      patched.indexOf("export class Workbench"),
    );
    javascript = stripTypeScriptTypes(
      helper + "\nglobalThis.setStage = setCantripWorkbenchStage;",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function fixture({
  nonce = "test_nonce_1234567890",
  editorPresent = true,
} = {}) {
  const messages = [];
  let receive;
  const parent = {
    postMessage: (message, origin) => messages.push({ message, origin }),
  };
  const mainWindow = {
    parent,
    location: { href: `http://localhost/code/?cantripFrameNonce=${nonce}` },
    document: { querySelector: () => (editorPresent ? {} : null) },
    addEventListener: (_type, callback) => {
      receive = callback;
    },
  };
  const context = { mainWindow, URL };
  vm.runInNewContext(javascript, context);
  const query = (
    data = { type: "cantrip-code.workbench-query", version: 1, nonce },
    source = parent,
  ) => receive({ data, source, origin: "https://app.cantrip.test" });
  return { messages, parent, context, query };
}

test("reports actual startup stages and replays version-one readiness after restoration", () => {
  const f = fixture();
  assert.equal(f.messages[0].message.stage, "bootstrapping");
  f.context.setStage("restoring");
  assert.equal(f.messages.at(-1).message.stage, "restoring");
  assert.equal(
    f.messages.some(
      ({ message }) => message.type === "cantrip-code.workbench-ready",
    ),
    false,
  );
  f.context.setStage("restored");
  f.messages.length = 0;
  f.query();
  f.query();
  assert.equal(
    f.messages.filter(
      ({ message }) => message.type === "cantrip-code.workbench-ready",
    ).length,
    2,
  );
  assert.equal(
    f.messages.every(({ origin }) => origin === "https://app.cantrip.test"),
    true,
  );
});

test("ignores foreign-window, stale-nonce, invalid-version, and malformed queries", () => {
  const f = fixture();
  f.context.setStage("restored");
  f.messages.length = 0;
  const query = {
    type: "cantrip-code.workbench-query",
    version: 1,
    nonce: "test_nonce_1234567890",
  };
  f.query(query, {});
  f.query({ ...query, nonce: "stale_nonce_12345678" });
  f.query({ ...query, version: 2 });
  f.query(null);
  assert.equal(f.messages.length, 0);
});

test("never reports ready for a missing editor part or malformed frame nonce", () => {
  for (const options of [{ editorPresent: false }, { nonce: "short" }]) {
    const f = fixture(options);
    f.context.setStage("restored");
    f.query();
    assert.equal(
      f.messages.some(
        ({ message }) => message.type === "cantrip-code.workbench-ready",
      ),
      false,
    );
  }
});

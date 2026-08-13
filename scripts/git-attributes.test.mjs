import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("keeps patches and the Codex snapshot byte-stable on Windows", () => {
  const files = [
    "cantrip_code/patches/0002-persist-web-workbench-state-on-server.patch",
    "cantrip_codex/upstream/codex-rs/protocol/src/protocol.rs",
    "cantrip_codex/patches/0001-explicit-empty-resume-dynamic-tools.patch",
  ];
  const output = execFileSync("git", ["check-attr", "text", "--", ...files], {
    cwd: root,
    encoding: "utf8",
  });
  for (const file of files) {
    assert.match(output, new RegExp(`^${file}: text: unset$`, "mu"));
  }
});

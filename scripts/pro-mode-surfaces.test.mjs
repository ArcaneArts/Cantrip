import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("Terminal service structural surfaces stay transparent in Pro Mode", async () => {
  const [styles, panel, terminalView] = await Promise.all([
    readFile(path.join(rootDir, "cantrip_app", "src", "index.css"), "utf8"),
    readFile(
      path.join(
        rootDir,
        "cantrip_app",
        "src",
        "components",
        "terminal",
        "terminal-service-panel.tsx",
      ),
      "utf8",
    ),
    readFile(
      path.join(
        rootDir,
        "cantrip_app",
        "src",
        "components",
        "terminal",
        "terminal-view.tsx",
      ),
      "utf8",
    ),
  ]);
  const transparentRules = [...styles.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
    .filter((match) => match[2]?.includes("background-color: transparent"))
    .map((match) => match[1] ?? "")
    .join("\n");

  assert.match(panel, /data-slot="terminal-service-panel"/);
  assert.match(
    terminalView,
    /surfaceDataSlot="terminal-service-panel-surface"/,
  );
  assert.match(
    transparentRules,
    /\.pro-mode \[data-slot="terminal-service-panel"\]/,
  );
  assert.match(
    transparentRules,
    /\.pro-mode \[data-slot="terminal-service-panel-surface"\]/,
  );
});

test("Run terminal surfaces use the shell background only in Pro Mode", async () => {
  const [styles, runTerminalView] = await Promise.all([
    readFile(path.join(rootDir, "cantrip_app", "src", "index.css"), "utf8"),
    readFile(
      path.join(
        rootDir,
        "cantrip_app",
        "src",
        "components",
        "terminal",
        "run-terminal-view.tsx",
      ),
      "utf8",
    ),
  ]);
  const rules = [...styles.matchAll(/([^{}]+)\{([^{}]+)\}/g)].filter((match) =>
    match[1]?.includes('[data-slot="run-terminal-view"]'),
  );

  assert.match(runTerminalView, /data-slot="run-terminal-view"/);
  assert.ok(rules.length, "The Run surface needs a Pro Mode transparency rule");
  for (const [, selectors, declarations] of rules) {
    const runSelectors = selectors
      .split(",")
      .filter((selector) =>
        selector.includes('[data-slot="run-terminal-view"]'),
      );
    assert.ok(
      runSelectors.every((selector) =>
        selector.trim().startsWith(".pro-mode "),
      ),
    );
    assert.match(declarations, /background-color:\s*transparent/);
  }
});

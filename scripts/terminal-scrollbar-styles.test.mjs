import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function ruleBody(styles, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1] ?? ""
  );
}

test("xterm scrollback stays usable without visible scrollbar chrome", async () => {
  const styles = await readFile(
    path.join(rootDir, "cantrip_app", "src", "index.css"),
    "utf8",
  );
  const viewportRule = ruleBody(styles, ".xterm .xterm-viewport");
  const webkitScrollbarRule = ruleBody(
    styles,
    ".xterm .xterm-viewport::-webkit-scrollbar",
  );

  assert.match(viewportRule, /scrollbar-width:\s*none/);
  assert.doesNotMatch(viewportRule, /overflow[^:]*:\s*hidden/);
  assert.match(webkitScrollbarRule, /display:\s*none/);
  assert.match(webkitScrollbarRule, /width:\s*0/);
  assert.match(webkitScrollbarRule, /height:\s*0/);
});

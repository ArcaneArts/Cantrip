import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("mobile text entry keeps the application viewport fixed", async () => {
  const [document, styles] = await Promise.all([
    readFile(path.join(rootDir, "cantrip_app", "index.html"), "utf8"),
    readFile(path.join(rootDir, "cantrip_app", "src", "index.css"), "utf8"),
  ]);

  assert.match(document, /maximum-scale=1\.0/);
  assert.match(document, /user-scalable=no/);
  assert.match(styles, /@media \(max-width: 767px\)/);
  assert.match(styles, /\[contenteditable\]/);
  assert.match(styles, /\[role="textbox"\]/);
  assert.match(styles, /font-size: 16px/);
});

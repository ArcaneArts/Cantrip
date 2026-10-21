import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit } from "playwright-core";
import { startNativeEditorFixture } from "./native-editor-fixture.mjs";

const directory = path.resolve("test-results/native-editor-close");
await mkdir(directory, { recursive: true });
const results = [];
for (const [name, engine] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const fixture = await startNativeEditorFixture();
  const original = await readFile(
    path.join(fixture.directory, "main.tsx"),
    "utf8",
  );
  const browser = await engine.launch({ headless: true });
  try {
    for (const phone of [false, true]) {
      const context = await browser.newContext({
        viewport: phone
          ? { width: 390, height: 844 }
          : { width: 1280, height: 800 },
        hasTouch: phone,
      });
      await context.addInitScript(() => {
        // Run the actual installed Tauri JS SDK against an explicit mock native host.
        const callbacks = new Map(),
          listeners = new Map();
        let nextId = 0;
        const state = {
          destroyed: 0,
          destroyAttempts: 0,
          failDestroy: false,
          commands: [],
        };
        window.isTauri = true;
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
          unregisterListener(_event, id) {
            listeners.delete(id);
          },
        };
        window.__TAURI_INTERNALS__ = {
          metadata: {
            currentWindow: { label: "cantrip-editor-close-qa" },
            currentWebview: { label: "cantrip-editor-close-qa" },
          },
          transformCallback(callback) {
            const id = ++nextId;
            callbacks.set(id, callback);
            return id;
          },
          unregisterCallback(id) {
            callbacks.delete(id);
          },
          async invoke(command, args) {
            state.commands.push(command);
            if (command === "plugin:event|listen") {
              const id = ++nextId;
              listeners.set(id, args);
              return id;
            }
            if (command === "plugin:event|unlisten") {
              listeners.delete(args.eventId);
              return;
            }
            if (command === "plugin:window|destroy") {
              state.destroyAttempts++;
              if (state.failDestroy) {
                state.failDestroy = false;
                throw new Error("Native close failed in QA");
              }
              state.destroyed++;
              return;
            }
            throw new Error(`Unexpected native command: ${command}`);
          },
        };
        window.__qaNativeClose = {
          state,
          listenerCount: () =>
            [...listeners.values()].filter(
              (entry) => entry.event === "tauri://close-requested",
            ).length,
          async request() {
            await Promise.all(
              [...listeners]
                .filter(
                  ([, entry]) => entry.event === "tauri://close-requested",
                )
                .map(([id, entry]) =>
                  callbacks.get(entry.handler)({
                    id,
                    event: entry.event,
                    payload: null,
                  }),
                ),
            );
          },
        };
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const url = new URL(fixture.url);
      url.pathname = "/qa/native-editor-close.html";
      await page.goto(url.href);
      const input = page.getByRole("textbox", {
        name: "Edit main.tsx",
        exact: true,
      });
      await input.waitFor();
      await page.waitForFunction(
        () => window.__qaNativeClose.listenerCount() === 1,
      );
      await input.fill(original + "// retained native close draft 😀é\n");
      const draft = await input.inputValue();
      await page.evaluate(() => {
        window.__qaPendingClose = window.__qaNativeClose.request();
      });
      await page
        .getByRole("dialog", { name: "Close file window?", exact: true })
        .waitFor();
      await page.evaluate(() => window.__qaNativeClose.request());
      assert.equal(await page.getByRole("dialog").count(), 1);
      await page.screenshot({
        path: path.join(
          directory,
          `${name}-${phone ? "phone" : "desktop"}.png`,
        ),
        animations: "disabled",
      });
      await page
        .getByRole("button", { name: "Keep editing", exact: true })
        .click();
      await page.evaluate(() => window.__qaPendingClose);
      assert.equal(await input.inputValue(), draft);
      assert.equal(
        await page.evaluate(() => window.__qaNativeClose.state.destroyed),
        0,
      );
      assert.equal(
        await readFile(path.join(fixture.directory, "main.tsx"), "utf8"),
        original,
      );

      await page.evaluate(() => {
        window.__qaNativeClose.state.failDestroy = true;
        window.__qaPendingClose = window.__qaNativeClose.request();
      });
      await page
        .getByRole("button", { name: "Close and discard", exact: true })
        .click();
      await page.evaluate(() => window.__qaPendingClose);
      await page
        .getByRole("alert")
        .filter({ hasText: "Native close failed in QA" })
        .waitFor();
      assert.equal(await input.inputValue(), draft);
      await page
        .getByRole("button", { name: "Retry close protection", exact: true })
        .click();
      await page.waitForFunction(
        () => window.__qaNativeClose.listenerCount() === 1,
      );

      fixture.delaySaves(1000);
      await input.press("ControlOrMeta+s");
      await page
        .getByLabel("Save state", { exact: true })
        .filter({ hasText: "saving" })
        .waitFor();
      await input.fill(original); // Dirty=false, but an earlier explicit write is still pending.
      await page.evaluate(() => {
        window.__qaPendingClose = window.__qaNativeClose.request();
      });
      await page.getByRole("dialog").waitFor();
      await page
        .getByRole("button", { name: "Keep editing", exact: true })
        .click();
      await page.evaluate(() => window.__qaPendingClose);
      await page
        .getByLabel("Save state", { exact: true })
        .filter({ hasText: "unsaved" })
        .waitFor();
      assert.equal(
        await readFile(path.join(fixture.directory, "main.tsx"), "utf8"),
        draft,
      );
      assert.equal(await input.inputValue(), original);
      fixture.delaySaves(0);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Save state"]').textContent ===
          "saved",
      );
      await page.evaluate(() => {
        window.__qaPendingClose = window.__qaNativeClose.request();
      });
      await page.waitForFunction(
        () => window.__qaNativeClose.state.destroyed === 1,
        undefined,
        { timeout: 5000 },
      );
      assert.equal(await page.getByRole("dialog").count(), 0);
      const native = await page.evaluate(() => window.__qaNativeClose.state);
      assert.equal(native.destroyed, 1);
      assert.equal(native.destroyAttempts, 2);
      assert.equal(
        await readFile(path.join(fixture.directory, "main.tsx"), "utf8"),
        original,
      );
      assert.deepEqual(errors, []);
      results.push({
        browser: name,
        layout: phone ? "phone viewport" : "desktop",
        status: "pass",
        nativeHost: "simulated; actual installed SDK",
        native,
      });
      await context.close();
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
}
await writeFile(
  path.join(directory, "results.json"),
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results, null, 2));

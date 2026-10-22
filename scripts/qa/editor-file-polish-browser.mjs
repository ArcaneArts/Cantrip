import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit } from "playwright-core";
import { startNativeEditorFixture } from "./native-editor-fixture.mjs";
import { checkNativeEditorReadOnly } from "./native-editor-input-acceptance.mjs";

const mit = (
  await readFile("cantrip_app/src/components/editor/licenses/MIT.txt", "utf8")
).replace(/Copyright[^\n]+/u, "Copyright (c) 2026 Arcane Arts");
const reserved = "Copyright (c) 2026 Arcane Arts\nAll rights reserved.\n";
const custom = "<script>window.__qaUnsafe=true</script>\nCustom license terms.";
const gradle =
  'plugins { id "java" }\nrepositories { mavenCentral() }\ndef version = "1.0" // build version\n';
const batch =
  '@REM Gradle launcher\n@ECHO OFF\nset "APP_HOME=%~dp0"\nset "JAVA_EXE=%JAVA_HOME%\\bin\\java.exe"\necho !APP_HOME!\n';
const directory = path.resolve("test-results/editor-file-polish");
await mkdir(directory, { recursive: true });
const results = [];
for (const [name, engine] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const fixture = await startNativeEditorFixture({
    LICENSE: mit,
    COPYING: reserved,
    "LICENSE.txt": custom,
    "build.gradle": gradle,
    "gradlew.bat": batch,
  });
  let browser;
  try {
    browser = await engine.launch({ headless: true });
    for (const phone of [false, true]) {
      await writeFile(path.join(fixture.directory, "LICENSE"), mit);
      const context = await browser.newContext({
        viewport: phone
          ? { width: 390, height: 844 }
          : { width: 1280, height: 900 },
        hasTouch: phone,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const open = async (file) => {
        const url = new URL(fixture.url);
        url.pathname = "/qa/editor-file-polish.html";
        url.searchParams.set("file", file);
        await page.goto(url.href);
      };
      await open("LICENSE");
      await page
        .getByRole("heading", { name: "MIT License", exact: true })
        .waitFor();
      assert.equal(
        await page.getByLabel("License text", { exact: true }).textContent(),
        mit,
      );
      assert.equal(await page.locator(".cantrip-editor-gutter").count(), 0);
      assert.equal(await page.getByRole("textbox").count(), 0);
      assert.ok(await page.getByLabel("License summary").boundingBox());
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.screenshot({
        path: path.join(
          directory,
          `${name}-${phone ? "phone" : "desktop"}-license.png`,
        ),
        animations: "disabled",
      });

      const writes = fixture.requests.filter(
        (request) => request.method === "PUT",
      ).length;
      await page.getByRole("button", { name: "Editor", exact: true }).click();
      let input = page.getByRole("textbox", {
        name: "Edit LICENSE",
        exact: true,
      });
      await input.waitFor();
      const draft = mit + "\nA local draft note.\n";
      await input.fill(draft);
      await page
        .getByRole("button", { name: "Read only", exact: true })
        .click();
      await page.getByLabel("License text", { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel("License text", { exact: true }).textContent(),
        draft,
      );
      assert.equal(
        await page
          .getByRole("heading", { name: "MIT License", exact: true })
          .count(),
        0,
      );
      assert.equal(
        fixture.requests.filter((request) => request.method === "PUT").length,
        writes,
      );
      await page.getByRole("button", { name: "Editor", exact: true }).click();
      input = page.getByRole("textbox", { name: "Edit LICENSE", exact: true });
      assert.equal(await input.inputValue(), draft);
      await page.getByRole("button", { name: "Save", exact: true }).waitFor();
      await input.press("ControlOrMeta+s");
      await page
        .getByRole("button", { name: "Save", exact: true })
        .waitFor({ state: "hidden" });
      assert.equal(
        await readFile(path.join(fixture.directory, "LICENSE"), "utf8"),
        draft,
      );

      await open("COPYING");
      await page
        .getByRole("heading", { name: "All rights reserved", exact: true })
        .waitFor();
      assert.equal(
        await page.getByLabel("License text", { exact: true }).textContent(),
        reserved,
      );
      await open("LICENSE.txt");
      await page.getByLabel("License text", { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel("License text", { exact: true }).textContent(),
        custom,
      );
      assert.equal(await page.getByLabel("License summary").count(), 0);
      assert.equal(await page.evaluate(() => window.__qaUnsafe), undefined);

      await open("build.gradle");
      input = page.getByRole("textbox", {
        name: "Edit build.gradle",
        exact: true,
      });
      await input.waitFor();
      await page
        .locator(".syntax-keyword")
        .filter({ hasText: /^def$/ })
        .waitFor();
      await page
        .locator(".syntax-function")
        .filter({ hasText: /^repositories$/ })
        .waitFor();
      const normalBackground = await page
        .locator(".cantrip-editor")
        .evaluate((node) => getComputedStyle(node).backgroundColor);
      assert.notEqual(normalBackground, "rgba(0, 0, 0, 0)");
      await page.evaluate(() =>
        document.documentElement.classList.add("pro-mode"),
      );
      await input.click();
      const style = await input.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          shadow: style.boxShadow,
          outline: style.outlineStyle,
          border: style.borderTopWidth,
          background: getComputedStyle(node.closest(".cantrip-editor"))
            .backgroundColor,
        };
      });
      assert.equal(style.shadow, "none");
      assert.equal(style.outline, "none");
      assert.equal(style.border, "0px");
      assert.equal(style.background, "rgba(0, 0, 0, 0)");
      await input.press("x");
      assert.notEqual(await input.inputValue(), gradle);
      const readOnlyAcceptance = await checkNativeEditorReadOnly(
        page,
        fixture,
        {
          viewButton: "Read only",
          editButton: "Editor",
          screenshotPath: path.join(
            directory,
            `${name}-${phone ? "phone" : "desktop"}-code-view.png`,
          ),
        },
      );
      await input.press("ControlOrMeta+z");
      assert.equal(await input.inputValue(), gradle);
      await page
        .locator(".syntax-keyword")
        .filter({ hasText: /^def$/ })
        .waitFor();
      await page.screenshot({
        path: path.join(
          directory,
          `${name}-${phone ? "phone" : "desktop"}-pro-editor.png`,
        ),
        animations: "disabled",
      });

      await open("gradlew.bat");
      await page
        .getByRole("textbox", { name: "Edit gradlew.bat", exact: true })
        .waitFor();
      await page
        .locator(".syntax-variable")
        .filter({ hasText: /^%~dp0$/ })
        .waitFor();
      await page
        .locator(".syntax-variable")
        .filter({ hasText: /^%JAVA_HOME%$/ })
        .waitFor();
      await page
        .locator(".syntax-comment")
        .filter({ hasText: /^REM Gradle launcher$/ })
        .waitFor();
      assert.deepEqual(errors, []);
      results.push({
        browser: name,
        layout: phone ? "phone viewport" : "desktop",
        status: "pass",
        proEditor: style,
        realLicenseDiskSave: true,
        actualDesktopFileComponent: true,
        readOnlyAcceptance,
      });
      await context.close();
    }
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
await writeFile(
  path.join(directory, "results.json"),
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results, null, 2));

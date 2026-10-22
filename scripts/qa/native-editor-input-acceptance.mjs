import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Exercise browser read-only input while preserving native selection/copy. */
export async function checkNativeEditorReadOnly(
  page,
  fixture,
  { viewButton = "View code", editButton = "Edit code", screenshotPath } = {},
) {
  const input = page.getByRole("textbox");
  const text = await input.inputValue();
  const writes = fixture.requests.filter(
    (request) => request.method === "PUT",
  ).length;
  await input.evaluate((node) => {
    window.__qaReadOnlyNode = node;
  });
  await page.getByRole("button", { name: viewButton, exact: true }).click();
  assert.equal(await input.evaluate((node) => node.readOnly), true);
  assert.match(await input.getAttribute("aria-label"), /^View /u);
  assert.equal(
    await input.evaluate((node) => getComputedStyle(node).caretColor),
    "rgba(0, 0, 0, 0)",
  );
  assert.ok(await page.locator(".cantrip-editor-gutter").count());
  await page.locator(".syntax-keyword").first().waitFor();
  await input.focus();
  await input.pressSequentially("blocked edit");
  await page.keyboard.insertText("\npasted text\n");
  for (const key of [
    "Backspace",
    "Delete",
    "ControlOrMeta+z",
    "ControlOrMeta+Shift+z",
    "ControlOrMeta+y",
    "ControlOrMeta+s",
  ])
    await input.press(key);
  const cancelled = await input.evaluate((node) => {
    const results = [
      "insertText",
      "insertFromPaste",
      "historyUndo",
      "historyRedo",
    ].map(
      (inputType) =>
        !node.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType,
            bubbles: true,
            cancelable: true,
          }),
        ),
    );
    node.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    node.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "日本語" }),
    );
    return results;
  });
  assert.deepEqual(cancelled, [true, true, true, true]);
  assert.equal(await input.inputValue(), text);
  await input.press("Tab");
  assert.equal(
    await input.evaluate((node) => node === document.activeElement),
    false,
  );
  await input.focus();
  await input.press("ControlOrMeta+a");
  await input.evaluate((node) => {
    window.__qaReadOnlyCopy = null;
    node.addEventListener(
      "copy",
      (event) => {
        window.__qaReadOnlyCopy = node.value.slice(
          node.selectionStart,
          node.selectionEnd,
        );
        // Observe native Copy without changing the user's clipboard.
        event.preventDefault();
      },
      { once: true },
    );
  });
  await input.press("ControlOrMeta+c");
  assert.equal(await page.evaluate(() => window.__qaReadOnlyCopy), text);
  assert.equal(
    fixture.requests.filter((request) => request.method === "PUT").length,
    writes,
  );
  const position = await input.evaluate((node) => [
    node.selectionStart,
    node.selectionEnd,
    node.scrollTop,
    node.scrollLeft,
  ]);
  if (screenshotPath)
    await page.screenshot({ path: screenshotPath, animations: "disabled" });
  await page.getByRole("button", { name: editButton, exact: true }).click();
  assert.equal(await input.evaluate((node) => node.readOnly), false);
  assert.equal(await input.inputValue(), text);
  assert.equal(
    await input.evaluate((node) => node === window.__qaReadOnlyNode),
    true,
  );
  assert.deepEqual(
    await input.evaluate((node) => [
      node.selectionStart,
      node.selectionEnd,
      node.scrollTop,
      node.scrollLeft,
    ]),
    position,
  );
  return {
    caretHidden: true,
    mutationsBlocked: true,
    copyAvailable: true,
    inputRetained: true,
  };
}

export async function measureNativeInputPaint(page, text) {
  await page.evaluate(() => {
    window.__qaInputPaintMs = null;
    document.querySelector("textarea").addEventListener(
      "input",
      () => {
        const started = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            window.__qaInputPaintMs = performance.now() - started;
          }),
        );
      },
      { once: true },
    );
  });
  await page.keyboard.insertText(text);
  await page.waitForFunction(
    () => typeof window.__qaInputPaintMs === "number",
    undefined,
    { timeout: 3000 },
  );
  return page.evaluate(() => window.__qaInputPaintMs);
}

/** Real native insertion plus deterministic composition-event simulation. */
export async function checkNativeEditorInput(page, fixture, screenshotPath) {
  await page.getByRole("button", { name: "other.py", exact: true }).click();
  const input = page.getByRole("textbox", {
    name: "Edit other.py",
    exact: true,
  });
  await input.waitFor();
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    await input.tap();
    assert.equal(
      await input.evaluate((node) => node === document.activeElement),
      true,
    );
  }
  await input.focus();
  const original = await input.inputValue();
  await input.evaluate((node) => {
    window.__qaInputNode = node;
    node.setSelectionRange(0, node.value.length);
    node.dispatchEvent(new Event("select", { bubbles: true }));
  });
  await input.press("Tab");
  const indented = await input.inputValue();
  assert.notEqual(indented, original);
  assert.ok(indented.startsWith("  def"));
  await input.press("Shift+Tab");
  assert.equal(await input.inputValue(), original);
  await input.press("ControlOrMeta+z");
  assert.equal(await input.inputValue(), indented);
  await input.press("ControlOrMeta+Shift+z");
  assert.equal(await input.inputValue(), original);

  await input.press(
    process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
  );
  // insertText exercises native multiline insertion without touching the user's clipboard.
  const inserted = "\n# inserted 😀é\nprint('paste <>&')\n";
  await page.keyboard.insertText(inserted);
  assert.equal(await input.inputValue(), original + inserted);
  await input.press("Backspace");
  assert.equal(await input.inputValue(), (original + inserted).slice(0, -1));
  await input.press("ControlOrMeta+z");
  assert.equal(await input.inputValue(), original + inserted);

  const beforeComposition = await input.inputValue();
  const writes = fixture.requests.filter(
    (request) => request.method === "PUT",
  ).length;
  await input.evaluate((node) =>
    node.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
    ),
  );
  await page.keyboard.insertText("日本語");
  await input.press("Tab");
  await input.press("ControlOrMeta+s");
  assert.equal(await input.inputValue(), beforeComposition + "日本語");
  assert.equal(
    fixture.requests.filter((request) => request.method === "PUT").length,
    writes,
  );
  await input.evaluate((node) =>
    node.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "日本語" }),
    ),
  );
  await input.press("ControlOrMeta+z");
  assert.equal(await input.inputValue(), beforeComposition);
  await input.press("ControlOrMeta+Shift+z");
  assert.equal(await input.inputValue(), beforeComposition + "日本語");

  const inputToPaintMs = await measureNativeInputPaint(page, "x");
  assert.equal(
    await input.evaluate((node) => node === window.__qaInputNode),
    true,
  );
  const submitted = await input.inputValue();
  fixture.delaySaves(250);
  const firstWrite = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/other.py"),
  );
  await input.press("ControlOrMeta+s");
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Save state"]').textContent ===
      "saving",
  );
  await page.keyboard.insertText(" newer typing");
  await (await firstWrite).finished();
  await page.waitForFunction(() => {
    const state = document.querySelector('[aria-label="Save state"]');
    return state.dataset.saving === "false" && state.textContent === "unsaved";
  });
  assert.equal(
    await readFile(path.join(fixture.directory, "other.py"), "utf8"),
    submitted,
  );
  assert.equal(await input.inputValue(), submitted + " newer typing");
  fixture.delaySaves(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Save state"]').textContent ===
      "saved",
  );
  assert.equal(
    await readFile(path.join(fixture.directory, "other.py"), "utf8"),
    await input.inputValue(),
  );
  await input.press("Escape");
  assert.equal(
    await input.evaluate((node) => node === document.activeElement),
    false,
  );

  const themeColors = [];
  for (const theme of ["", "dark", "high-contrast", "dark high-contrast"]) {
    await page.evaluate((value) => {
      document.documentElement.className = value;
    }, theme);
    themeColors.push(
      await page
        .locator(".syntax-keyword")
        .first()
        .evaluate((node) => getComputedStyle(node).color),
    );
  }
  assert.equal(new Set(themeColors).size, 4);
  await page.screenshot({ path: screenshotPath });
  await page.emulateMedia({ forcedColors: "active" });
  if (
    await page.evaluate(() => matchMedia("(forced-colors: active)").matches)
  ) {
    assert.equal(
      await page
        .locator(".cantrip-editor-paint")
        .evaluate((node) => getComputedStyle(node).display),
      "none",
    );
    assert.notEqual(
      await input.evaluate(
        (node) => getComputedStyle(node).webkitTextFillColor,
      ),
      "rgba(0, 0, 0, 0)",
    );
  } else
    throw new Error(
      "This browser did not apply its requested forced-colors emulation",
    );
  await page.emulateMedia({ forcedColors: "none" });
  await page.evaluate(() => {
    document.documentElement.className = "";
  });
  await page.getByRole("button", { name: "main.tsx", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Edit main.tsx", exact: true })
    .waitFor();
  return {
    inputToPaintMs,
    composition: "simulated events with native insertion",
    themes: themeColors,
  };
}

export async function checkNativeEditorLongLine(page, input) {
  await input.evaluate((node) => {
    node.scrollTop = 100 * 24;
    node.dispatchEvent(new Event("scroll"));
  });
  const line = page.locator('[data-editor-line="101"]');
  await line.waitFor();
  await line.locator(".syntax-comment").waitFor();
  const longLineCharacters = (await line.textContent()).length;
  const before = await line.boundingBox();
  const gutterBefore = await page
    .locator(".cantrip-editor-gutter")
    .boundingBox();
  const scrolled = await input.evaluate((node) => {
    node.scrollLeft = 1200;
    node.dispatchEvent(new Event("scroll"));
    return node.scrollLeft;
  });
  await page.waitForFunction(
    (left) =>
      document
        .querySelector(".cantrip-editor-code")
        .style.transform.startsWith(`translate(${-left}px,`),
    scrolled,
  );
  const after = await line.boundingBox();
  assert.equal(before.x - after.x, scrolled);
  assert.ok(scrolled > 1000);
  assert.equal(
    (await page.locator(".cantrip-editor-gutter").boundingBox()).x,
    gutterBefore.x,
  );
  const viewport = page.viewportSize();
  await page.setViewportSize({
    width: viewport.width,
    height: Math.max(420, viewport.height - 280),
  });
  await page.waitForFunction(() => {
    const node = document.querySelector("textarea");
    return node.getBoundingClientRect().bottom <= innerHeight;
  });
  await page.setViewportSize(viewport);
  assert.ok((await page.locator("[data-editor-line]").count()) < 80);
  await input.evaluate((node) => {
    node.scrollLeft = 0;
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll"));
  });
  await page.locator('[data-editor-line="20001"]').waitFor();
  return { longLineCharacters, horizontalScroll: scrolled };
}

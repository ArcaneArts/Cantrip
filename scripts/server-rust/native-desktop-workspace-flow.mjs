import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function click(label) {
  const element = [
    ...document.querySelectorAll(
      "button,[role=menuitem],[role=treeitem],[role=tab]",
    ),
  ].find(
    (node) =>
      node.getClientRects().length &&
      (node.getAttribute("aria-label") === label ||
        node.textContent.trim() === label),
  );
  if (!element) throw new Error("Missing native UI control: " + label);
  element.click();
  return true;
}

// Serialized actions execute inside the disposable real WKWebView. `editor`
// is the bridge's visible-editor lookup, not a substitute editor implementation.
function edit(name, text) {
  const input = editor(name);
  if (!input) throw new Error("Visible editor missing: " + name);
  input.focus();
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  ).set.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return input.value;
}

export async function nativeDesktopWorkspaceFlow({
  bridge,
  fixture,
  projectId,
  recoveryFile,
  directory,
  crashApp,
  capture,
  record,
}) {
  const { evaluate, until } = bridge;
  const recovery = await readFile(recoveryFile, "utf8");
  await until("main", () =>
    Boolean(document.querySelector("input[type=file]")),
  );
  await evaluate(
    "main",
    (content) => {
      const input = document.querySelector("input[type=file]");
      const files = new DataTransfer();
      files.items.add(
        new File([content], "disposable-recovery.json", {
          type: "application/json",
        }),
      );
      input.files = files.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    recovery,
  );
  await until("main", () => {
    if (document.querySelector('button[aria-label="Switch project"]'))
      return true;
    const choice = [...document.querySelectorAll("[role=menuitem]")].find(
      (n) => n.textContent.trim() === "Cantrip IDE",
    );
    if (choice) choice.click();
    else
      document
        .querySelector('button[aria-label="Chat. Switch Cantrip mode"]')
        ?.click();
    return false;
  });
  await evaluate("main", click, "Switch project");
  await until("main", () =>
    [...document.querySelectorAll("[data-slot=project-switcher-project]")].some(
      (n) => n.textContent.includes("Editor-Recovery-QA"),
    ),
  );
  await evaluate("main", () => {
    [...document.querySelectorAll("[data-slot=project-switcher-project]")]
      .find((n) => n.textContent.includes("Editor-Recovery-QA"))
      .click();
    return true;
  });
  const waitText = (label, name, text) =>
    until(label, ({ name, text }) => editor(name)?.value === text, {
      name,
      text,
    });
  const files = fixture.repositorySeed.repository;
  const baseline = {
    first: "Cantrip editor recovery baseline\n",
    second: "Cantrip second preview file\n",
  };
  const marker = crypto.randomUUID();
  const first =
    "Native detached draft 🦀 " +
    marker +
    "\n" +
    Array.from({ length: 110 }, (_, i) => "Unsaved first " + i).join("\n") +
    "\n";
  const second =
    "Native inactive draft 🌿 " +
    marker +
    "\n" +
    Array.from({ length: 110 }, (_, i) => "Unsaved second " + i).join("\n") +
    "\n";
  const layout = () =>
    evaluate("main", (id) => window.__qaNativeWorkspace(id), projectId);
  const tabs = (state) =>
    state.windows.flatMap((w) =>
      w.panes.flatMap((p) =>
        p.tabs
          .filter((t) => t.resource.definitionId === "project.file")
          .map((t) => ({ ...t, windowId: w.id })),
      ),
    );
  const snapshot = async (name) => {
    const state = await layout();
    await writeFile(
      path.join(directory, name + ".json"),
      JSON.stringify(state, null, 2),
    );
    return state;
  };
  const unchanged = async () => {
    assert.equal(
      await readFile(path.join(files, "qa.txt"), "utf8"),
      baseline.first,
    );
    assert.equal(
      await readFile(path.join(files, "second.txt"), "utf8"),
      baseline.second,
    );
  };
  await until("main", () =>
    [...document.querySelectorAll("[role=treeitem]")].some(
      (n) => n.textContent.trim() === "qa.txt",
    ),
  );
  await evaluate("main", click, "qa.txt");
  await waitText("main", "qa.txt", baseline.first);
  assert.equal(await evaluate("main", edit, "qa.txt", first), first);
  await evaluate("main", click, "second.txt");
  await waitText("main", "second.txt", baseline.second);
  assert.equal(await evaluate("main", edit, "second.txt", second), second);
  await evaluate("main", click, "qa.txt");
  await waitText("main", "qa.txt", first);
  const original = await snapshot("before-detach");
  const ids = tabs(original)
    .map((t) => t.id)
    .sort();
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
  await unchanged();
  record("native-workspace.two-dirty-files", { tabIds: ids });
  const selection = await evaluate("main", async () => {
    const input = editor("qa.txt");
    input.focus();
    input.setSelectionRange(100, 116);
    input.dispatchEvent(new Event("select", { bubbles: true }));
    input.scrollTop = 42;
    input.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    return {
      selection: [input.selectionStart, input.selectionEnd],
      scrollTop: input.scrollTop,
    };
  });
  assert.equal(selection.scrollTop, 42);
  await evaluate("main", () => {
    const button = document.querySelector(
      'button[aria-label="Actions for qa.txt"]',
    );
    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      }),
    );
    button.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      }),
    );
    return true;
  });
  await until("main", () =>
    [...document.querySelectorAll("[role=menuitem]")].some(
      (n) => n.textContent.trim() === "Pop Out",
    ),
  );
  await evaluate("main", click, "Pop Out");
  const popout = await until(
    "main",
    async () =>
      (await window.__qaNativeWindows()).find((w) => w.label !== "main")
        ?.label ?? null,
  );
  await waitText(popout, "qa.txt", first);
  await waitText("main", "second.txt", second);
  const moved = await snapshot("after-detach");
  assert.deepEqual(
    tabs(moved)
      .map((t) => t.id)
      .sort(),
    ids,
  );
  assert.equal(tabs(moved).filter((t) => t.windowId === popout).length, 1);
  assert.equal(moved.pendingTransfers.length, 0);
  assert.deepEqual(
    await evaluate(popout, () => {
      const input = editor("qa.txt");
      return {
        selection: [input.selectionStart, input.selectionEnd],
        scrollTop: input.scrollTop,
      };
    }),
    selection,
  );
  await unchanged();
  await capture("detached");
  record("native-workspace.real-popout", {
    popout,
    exactTabs: true,
    selectionAndScroll: true,
    inactiveDraft: true,
  });
  const before = await fixture.inject({ type: "stats" });
  const identity = await fetch(fixture.origin + "/api/bootstrap").then((r) =>
    r.json(),
  );
  const restart = await fixture.inject({ type: "restart", process: "server" });
  assert.notEqual(restart.children.server.pid, before.children.server.pid);
  assert.equal(
    (await fetch(fixture.origin + "/api/bootstrap").then((r) => r.json()))
      .server.id,
    identity.server.id,
  );
  await waitText(popout, "qa.txt", first);
  await waitText("main", "second.txt", second);
  assert.deepEqual(
    tabs(await snapshot("after-server-restart"))
      .map((t) => t.id)
      .sort(),
    ids,
  );
  await unchanged();
  record("native-workspace.rust-server-restart", {
    oldPid: before.children.server.pid,
    newPid: restart.children.server.pid,
    exactIdentityTabsAndDrafts: true,
  });
  const oldContext = await evaluate(popout, () => {
    setTimeout(() => location.reload(), 250);
    return window.__qaNativeContext;
  });
  await until(popout, (old) => window.__qaNativeContext !== old, oldContext);
  await waitText(popout, "qa.txt", first);
  for (const redo of [false, true]) {
    await evaluate(
      popout,
      (redo) => {
        const input = editor("qa.txt");
        input.focus();
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "z",
            code: "KeyZ",
            metaKey: true,
            shiftKey: redo,
            bubbles: true,
            cancelable: true,
          }),
        );
        return true;
      },
      redo,
    );
    await waitText(popout, "qa.txt", redo ? first : baseline.first);
  }
  await unchanged();
  record("native-workspace.renderer-reload", {
    newContext: true,
    exactDraftAndUndoHistory: true,
  });
  const mainContext = await evaluate("main", () => window.__qaNativeContext);
  const popoutContext = await evaluate(popout, () => window.__qaNativeContext);
  const crash = await crashApp();
  await until("main", (old) => window.__qaNativeContext !== old, mainContext);
  await until(popout, (old) => window.__qaNativeContext !== old, popoutContext);
  await waitText(popout, "qa.txt", first);
  await waitText("main", "second.txt", second);
  assert.deepEqual(
    tabs(await snapshot("after-app-crash"))
      .map((t) => t.id)
      .sort(),
    ids,
  );
  await unchanged();
  await capture("after-app-crash");
  record("native-workspace.app-sigkill-restart", {
    ...crash,
    samePopout: popout,
    exactTabsAndDrafts: true,
  });
  await evaluate(
    popout,
    (label) => {
      setTimeout(async () => {
        await (
          await window.__qaNativeWindows()
        )
          .find((w) => w.label === label)
          .close();
      }, 250);
      return true;
    },
    popout,
  );
  await until(
    "main",
    async () => (await window.__qaNativeWindows()).length === 1,
  );
  await waitText("main", "qa.txt", first);
  const returned = await snapshot("after-native-close");
  assert.deepEqual(
    tabs(returned)
      .map((t) => t.id)
      .sort(),
    ids,
  );
  assert.ok(tabs(returned).every((t) => t.windowId === returned.mainWindowId));
  await unchanged();
  record("native-workspace.native-close-returns-draft", {
    exactTabs: true,
    bothViewsInMain: true,
  });
  await evaluate("main", click, "Save file");
  const deadline = Date.now() + 15_000;
  while ((await readFile(path.join(files, "qa.txt"), "utf8")) !== first) {
    if (Date.now() > deadline)
      throw new Error("Explicit Save did not reach the worker file");
    await delay(100);
  }
  assert.equal(
    await readFile(path.join(files, "second.txt"), "utf8"),
    baseline.second,
  );
  await capture("saved-and-unsaved");
  record("native-workspace.explicit-encrypted-save", {
    firstWritten: true,
    secondUnchanged: true,
  });
}

import assert from "node:assert/strict";
import {
  applyWorkspaceCommand,
  workspaceActionSchema,
} from "../../packages/protocol/dist/index.js";
import { projectLabel } from "./security-fixtures.mjs";
import { workspaceLayoutWireFixtures } from "./workspace-layout-wire-fixtures.mjs";
import {
  workspaceState,
  workspaceTab,
  workspacePane,
} from "./workspace-wire-fixtures.mjs";

export function workspaceCommandModelCases(add) {
  const base = workspaceState();
  const copy = (value) => structuredClone(value);
  const fixtures =
    workspaceLayoutWireFixtures(projectLabel).workspaceCommandSchema;
  assert.deepEqual(
    new Set(fixtures.map((v) => v.action.type)),
    new Set(workspaceActionSchema.options.map((v) => v.shape.type.value)),
    "every actual action has a wire/model fixture",
  );
  function command(initial, action, windowId = "main", changes = {}) {
    return {
      operationId: "operation",
      workspaceId: initial.id,
      projectId: initial.projectId,
      windowId,
      attachmentGeneration:
        initial.windows.find((w) => w.id === windowId)?.attachmentGeneration ??
        1,
      expectedRevision: initial.revision,
      action,
      ...changes,
    };
  }
  function emit(name, initial, action, windowId = "main", changes = {}) {
    const input = command(initial, action, windowId, changes);
    add(name, "apply", { initial, input });
  }
  function step(name, initial, action, windowId = "main") {
    const input = command(initial, action, windowId);
    add(name, "apply", { initial, input });
    return applyWorkspaceCommand(initial, input).layout;
  }
  for (const fixture of fixtures) {
    emit("wire action " + fixture.action.type, base, fixture.action);
    for (const [field, value] of Object.entries(fixture.action)) {
      if (!field.endsWith("Id") || typeof value !== "string") continue;
      for (const identity of [
        "missing",
        "a",
        "b",
        "c",
        "center-a",
        "center-b",
        "main",
        "detached",
        "\ud800",
      ])
        emit(
          "action identity " +
            fixture.action.type +
            " " +
            field +
            " " +
            JSON.stringify(identity),
          base,
          { ...fixture.action, [field]: identity },
        );
    }
    for (const change of [
      { workspaceId: "foreign" },
      { projectId: "foreign" },
      { expectedRevision: 1 },
      { windowId: "missing" },
      { attachmentGeneration: 0 },
    ])
      emit(
        "boundary " + fixture.action.type + " " + JSON.stringify(change),
        base,
        fixture.action,
        "main",
        change,
      );
  }
  for (const tabId of ["a", "b", "c", "missing"]) {
    for (const type of ["select", "close-tab", "pin"])
      emit(type + " " + tabId, base, { type, tabId });
  }
  emit(
    "last detached view retires its native window",
    base,
    { type: "close-tab", tabId: "detached-tab" },
    "detached",
  );
  for (const paneId of ["center-a", "center-b", "missing"])
    emit("close pane " + paneId, base, { type: "close-pane", paneId });
  const dock = copy(base);
  dock.windows[0].panes.push(
    workspacePane(
      "dock-pane",
      [workspaceTab("dock-tab", "dock-resource")],
      "right",
    ),
  );
  emit("dock presentation", dock, {
    type: "dock-presentation",
    tabId: "dock-tab",
    presentation: {
      preferredMode: "split",
      splitFraction: 0.32,
      restoreFraction: 0.32,
    },
  });
  emit("opaque pane title", base, {
    type: "rename-pane",
    paneId: "center-a",
    titleProtection: {
      ...projectLabel,
      classification: { recordKind: "tab-group" },
    },
  });
  for (const paneIds of [
    ["center-b", "center-a"],
    ["center-a"],
    ["center-a", "center-a"],
    ["missing", "center-b"],
  ])
    emit("reorder panes " + paneIds, base, {
      type: "reorder-panes",
      region: "center",
      paneIds,
    });
  emit("empty dock ordering", base, {
    type: "reorder-panes",
    region: "right",
    paneIds: [],
  });
  for (const tabIds of [["b", "a"], ["a"], ["b", "b"], ["missing", "a"]])
    emit("reorder tabs " + tabIds, base, {
      type: "reorder",
      paneId: "center-a",
      tabIds,
    });
  for (const [tabId, targetPaneId, position] of [
    ["a", "center-a", 1],
    ["b", "center-b", 1],
    ["c", "center-a", 0],
    ["a", "center-b", 5],
    ["missing", "missing", 0],
  ])
    emit("move " + [tabId, targetPaneId, position], base, {
      type: "move",
      tabId,
      targetPaneId,
      position,
    });
  for (const region of ["center", "right", "bottom"])
    for (const [tabId, position] of [
      ["a", 0],
      ["c", 1],
      ["b", 50],
    ])
      emit("move new pane " + [region, tabId, position], base, {
        type: "move-new-pane",
        tabId,
        paneId: "new-pane",
        region,
        position,
        splitId: "new-split",
      });
  for (const edge of ["left", "right", "top", "bottom"])
    for (const targetPaneId of ["center-a", "center-b"])
      emit("split " + edge + targetPaneId, base, {
        type: "split",
        tabId: "a",
        targetPaneId,
        paneId: "new-pane",
        splitId: "new-split",
        edge,
        fraction: 0.3,
      });
  emit("split cannot empty its target", base, {
    type: "split",
    tabId: "c",
    targetPaneId: "center-b",
    paneId: "new-pane",
    splitId: "new-split",
    edge: "left",
    fraction: 0.5,
  });
  emit("split requires center target", dock, {
    type: "split",
    tabId: "a",
    targetPaneId: "dock-pane",
    paneId: "new-pane",
    splitId: "new-split",
    edge: "left",
    fraction: 0.5,
  });
  for (const fraction of [0.1, 0.9, 0.05])
    emit("resize " + fraction, base, {
      type: "resize",
      splitId: "center-split",
      fraction,
    });
  const file = copy(base);
  file.windows[0].panes[0].tabs[0] = {
    ...workspaceTab("a", "old-file", "project.file"),
    preview: true,
  };
  emit("file display mode", file, {
    type: "file-mode",
    tabId: "a",
    mode: "visual",
  });
  const freshFile = {
    ...workspaceTab("new-file", "new-document", "project.file"),
    preview: true,
  };
  emit("replace actual preview", file, {
    type: "open",
    tab: freshFile,
    replacePreviewTabId: "a",
    target: { kind: "pane", paneId: "center-a" },
  });
  const pinned = copy(file);
  pinned.windows[0].panes[0].tabs[0].preview = false;
  emit("winning pin retains old view", pinned, {
    type: "open",
    tab: freshFile,
    replacePreviewTabId: "a",
    target: { kind: "pane", paneId: "center-a" },
  });
  emit("preview replacement must share pane", file, {
    type: "open",
    tab: freshFile,
    replacePreviewTabId: "a",
    target: { kind: "pane", paneId: "center-b" },
  });
  emit("replacement requires file types", base, {
    type: "open",
    tab: freshFile,
    replacePreviewTabId: "a",
    target: { kind: "pane", paneId: "center-a" },
  });
  emit("new pane cannot replace preview", file, {
    type: "open",
    tab: freshFile,
    replacePreviewTabId: "a",
    target: {
      kind: "new-pane",
      paneId: "new-pane",
      region: "center",
      splitId: "new-split",
    },
  });
  for (const region of ["center", "right", "bottom"])
    emit("open new " + region, base, {
      type: "open",
      tab: workspaceTab("new", "new-resource"),
      target: {
        kind: "new-pane",
        paneId: "new-pane",
        region,
        splitId: "new-split",
      },
    });
  emit("open existing first matching resource", base, {
    type: "open",
    tab: workspaceTab("new", "terminal"),
    target: { kind: "pane", paneId: "missing" },
  });
  const remote = copy(base);
  remote.windows[1].panes[0].tabs[0].resource.resourceId = "unique-remote";
  remote.windows[1].panes[0].tabs[0].preview = true;
  emit("promote existing view in another window", remote, {
    type: "open",
    tab: workspaceTab("new", "unique-remote"),
    target: { kind: "pane", paneId: "missing" },
  });
  const permanent = copy(remote);
  permanent.windows[1].panes[0].tabs[0].preview = false;
  emit("preview open never demotes a pinned view", permanent, {
    type: "open",
    tab: { ...workspaceTab("new", "unique-remote"), preview: true },
    target: { kind: "pane", paneId: "missing" },
  });
  emit("duplicate new tab identity", base, {
    type: "open",
    tab: workspaceTab("a", "brand-new"),
    target: { kind: "pane", paneId: "center-a" },
  });
  const exhausted = copy(base);
  exhausted.revision = Number.MAX_SAFE_INTEGER;
  emit("revision exhaustion", exhausted, { type: "home" });

  const code = copy(base);
  code.windows[0].panes[0].tabs[0] = workspaceTab("a", "code", "project.code");
  const codeAction = {
    type: "migrate-code-files",
    tabId: "a",
    codeId: "code",
    expectedWorkerId: "worker",
    expectedWorktreeId: "tree",
    views: [{ tabId: "code-file", documentId: "document", mode: "edit" }],
  };
  const convertedCode = step("convert Code files", code, codeAction);
  const replayedCode = step(
    "same Code conversion does not recreate views",
    convertedCode,
    codeAction,
  );
  const closedCodeFile = step("close migrated Code view", replayedCode, {
    type: "close-tab",
    tabId: "code-file",
  });
  emit(
    "Code receipt survives closing migrated file",
    closedCodeFile,
    codeAction,
  );
  const changedCode = copy(codeAction);
  changedCode.views[0].mode = "visual";
  emit("Code receipt identity cannot change", convertedCode, changedCode);
  const occupiedCode = copy(codeAction);
  occupiedCode.views[0].tabId = "b";
  emit("Code conversion cannot reuse view identity", code, occupiedCode);
  const explorer = copy(base);
  explorer.windows[0].panes[0].tabs[0] = {
    ...workspaceTab("a", "explorer", "project.explorer"),
    preview: true,
    titleProtection: {
      ...projectLabel,
      classification: { recordKind: "explorer" },
    },
  };
  const explorerAction = {
    type: "migrate-explorer-file",
    tabId: "a",
    explorerId: "explorer",
    expectedWorkerId: "worker",
    expectedWorktreeId: "tree",
    expectedStateProtection: {
      classification: { recordKind: "explorer-state" },
      protectedState: projectLabel.protectedLabel,
    },
    documentId: "selected",
    mode: "edit",
    retainedViews: [
      { tabId: "retained", documentId: "retained-document", mode: "visual" },
    ],
  };
  const convertedExplorer = step(
    "convert Explorer without moving selection",
    explorer,
    explorerAction,
  );
  emit(
    "Explorer binding changes after conversion",
    convertedExplorer,
    explorerAction,
  );
  const duplicateExplorer = copy(explorerAction);
  duplicateExplorer.retainedViews[0].documentId = "selected";
  emit(
    "Explorer conversion rejects repeated document",
    explorer,
    duplicateExplorer,
  );

  const prepare = (whole = true, tabId = "a") => ({
    type: "prepare-detach",
    transferId: "transfer",
    paneId: tabId === "c" ? "center-b" : "center-a",
    ...(whole ? {} : { tabId }),
    destinationWindowId: "new-window",
    destinationPaneId: whole ? "center-a" : "new-pane",
  });
  const prepared = step(
    "prepare whole pane without moving ownership",
    base,
    prepare(),
  );
  emit("same renderer retains preparation", prepared, {
    type: "replace-attachment",
    rendererId: "renderer",
  });
  emit("source renderer replacement retires reservation", prepared, {
    type: "replace-attachment",
    rendererId: "replacement",
  });
  const attached = step(
    "first destination renderer retains generation",
    prepared,
    { type: "replace-attachment", rendererId: "destination-renderer" },
    "new-window",
  );
  emit(
    "replacing destination renderer cancels orphan reservation",
    attached,
    { type: "replace-attachment", rendererId: "new-destination-renderer" },
    "new-window",
  );
  emit(
    "destination reserved against ordinary commands",
    prepared,
    { type: "home" },
    "new-window",
  );
  emit(
    "state readiness requires application readiness",
    prepared,
    { type: "transfer-state-ready", transferId: "transfer" },
    "new-window",
  );
  emit("source cannot acknowledge destination", prepared, {
    type: "transfer-ready",
    transferId: "transfer",
  });
  emit("commit requires state acknowledgment", prepared, {
    type: "commit-transfer",
    transferId: "transfer",
  });
  emit("cancel preserves source and retires destination", prepared, {
    type: "cancel-transfer",
    transferId: "transfer",
  });
  const ready = step(
    "destination ready",
    attached,
    { type: "transfer-ready", transferId: "transfer" },
    "new-window",
  );
  const restored = step(
    "destination restored",
    ready,
    { type: "transfer-state-ready", transferId: "transfer" },
    "new-window",
  );
  emit(
    "late application ready does not regress restored phase",
    restored,
    { type: "transfer-ready", transferId: "transfer" },
    "new-window",
  );
  const committed = step("source commits whole pane", restored, {
    type: "commit-transfer",
    transferId: "transfer",
  });
  const returning = step(
    "prepare whole-pane return",
    committed,
    {
      type: "prepare-return",
      transferId: "return",
      paneId: "center-a",
      splitId: "return-split",
    },
    "new-window",
  );
  emit(
    "return cancel leaves main window intact",
    returning,
    { type: "cancel-transfer", transferId: "return" },
    "new-window",
  );
  const returnReady = step("main acknowledges return", returning, {
    type: "transfer-ready",
    transferId: "return",
  });
  const returnRestored = step("main restores return state", returnReady, {
    type: "transfer-state-ready",
    transferId: "return",
  });
  step(
    "whole-pane return restores original split topology",
    returnRestored,
    { type: "commit-transfer", transferId: "return" },
    "new-window",
  );
  for (const tabId of ["a", "c"]) {
    let current = step(
      "prepare single tab " + tabId,
      base,
      prepare(false, tabId),
    );
    current = step(
      "single-tab destination ready " + tabId,
      current,
      { type: "transfer-ready", transferId: "transfer" },
      "new-window",
    );
    current = step(
      "single-tab state ready " + tabId,
      current,
      { type: "transfer-state-ready", transferId: "transfer" },
      "new-window",
    );
    current = step("single-tab commit " + tabId, current, {
      type: "commit-transfer",
      transferId: "transfer",
    });
    current = step(
      "single-tab return prepare " + tabId,
      current,
      {
        type: "prepare-return",
        transferId: "return",
        paneId: "new-pane",
        splitId: "return-split",
      },
      "new-window",
    );
    current = step("single-tab return app ready " + tabId, current, {
      type: "transfer-ready",
      transferId: "return",
    });
    current = step("single-tab return state ready " + tabId, current, {
      type: "transfer-state-ready",
      transferId: "return",
    });
    step(
      "single-tab return commit " + tabId,
      current,
      { type: "commit-transfer", transferId: "return" },
      "new-window",
    );
  }
  const frozen = copy(base);
  frozen.windows[0].attachmentGeneration = Number.MAX_SAFE_INTEGER;
  emit("same renderer at maximum generation remains current", frozen, {
    type: "replace-attachment",
    rendererId: "renderer",
  });
  emit("generation exhaustion cannot wrap", frozen, {
    type: "replace-attachment",
    rendererId: "replacement",
  });
  const preparedFile = step(
    "prepare file preview transfer",
    file,
    prepare(false),
  );
  emit("reserved preview cannot be replaced", preparedFile, {
    type: "open",
    tab: freshFile,
    replacePreviewTabId: "a",
    target: { kind: "pane", paneId: "center-a" },
  });
}

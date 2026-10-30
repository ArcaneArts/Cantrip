// Compare native commands against the actual shared conversation transforms.
import { applyWorkspaceCommand } from "../../packages/protocol/dist/index.js";

export function workspaceConversationModelCases(add) {
  const view = (id, definitionId = "project.agent") => ({
    id,
    resource: { kind: "entity", definitionId, resourceId: `resource-${id}` },
    preview: false,
    titleProtection: null,
    builtInState: null,
    dockPresentation: null,
  });
  const legacy = {
    version: 1,
    id: "workspace",
    projectId: "project",
    revision: 1,
    mainWindowId: "main",
    windows: [
      {
        id: "main",
        attachmentGeneration: 1,
        panes: [
          {
            id: "pane",
            region: "center",
            titleProtection: null,
            tabs: [view("terminal", "project.terminal")],
            activeTabId: "terminal",
          },
        ],
        centerRoot: { kind: "pane", paneId: "pane" },
        focusedPaneId: "pane",
        recentPaneIds: ["pane"],
      },
    ],
  };
  const input = (initial, action) => ({
    operationId: `operation-${initial.revision}`,
    workspaceId: initial.id,
    projectId: initial.projectId,
    windowId: "main",
    attachmentGeneration: 1,
    expectedRevision: initial.revision,
    action,
  });
  const run = (name, initial, action) => {
    const request = input(initial, action);
    add(`conversation: ${name}`, "apply", { initial, input: request });
  };
  const open = {
    type: "open-conversation",
    view: view("conversation"),
    newPaneId: "new-pane",
    splitId: "split",
  };
  run("migrate legacy and open", legacy, open);
  const direct = applyWorkspaceCommand(legacy, input(legacy, open)).layout;
  for (const action of [
    { type: "select", tabId: "terminal" },
    { type: "select", tabId: "conversation" },
    { type: "close-conversation", viewId: "conversation" },
    { type: "close-conversation", viewId: "terminal" },
    { type: "close-tab", tabId: "conversation" },
    { type: "close-tab", tabId: "terminal" },
    { type: "pin", tabId: "conversation" },
    { type: "move", tabId: "conversation", targetPaneId: "pane", position: 0 },
    { type: "move", tabId: "conversation", targetPaneId: "pane", position: 1 },
    {
      type: "move-new-pane",
      tabId: "terminal",
      paneId: "moved",
      region: "center",
      position: 1,
      splitId: "split",
    },
    ...["conversation", "terminal"].map((tabId) => ({
      type: "split",
      tabId,
      targetPaneId: "pane",
      paneId: "split-pane",
      splitId: "split",
      edge: "right",
      fraction: 0.5,
    })),
    {
      ...open,
      view: view("replacement"),
      expectedConversationViewId: "conversation",
    },
    { ...open, view: view("replacement"), expectedConversationViewId: null },
    {
      type: "open",
      tab: { ...view("conversation"), id: "duplicate" },
      target: { kind: "pane", paneId: "pane" },
    },
  ])
    run(JSON.stringify(action), direct, action);
  const closeRail = { type: "close-tab", tabId: "terminal" };
  const only = applyWorkspaceCommand(direct, input(direct, closeRail)).layout;
  run("convert tab-free slot to rail", only, {
    type: "move",
    tabId: "conversation",
    targetPaneId: "pane",
    position: 0,
  });
  run("close tab-free slot", only, {
    type: "close-conversation",
    viewId: "conversation",
  });
  run("reject split with no surviving target", only, {
    type: "split",
    tabId: "conversation",
    targetPaneId: "pane",
    paneId: "split-pane",
    splitId: "split",
    edge: "right",
    fraction: 0.5,
  });
  add("conversation: legacy import preserves version two selection", "import", {
    initial: direct,
    input: {
      windowId: "cantrip-editor-conversation-import",
      paneId: "imported",
      views: [{ tabId: "imported-file", documentId: "document", mode: "edit" }],
    },
    titles: { document: null },
  });
  function step(name, initial, action, windowId = "main") {
    const request = {
      ...input(initial, action),
      windowId,
      attachmentGeneration: initial.windows.find((w) => w.id === windowId)
        .attachmentGeneration,
    };
    add(`conversation transfer: ${name}`, "apply", { initial, input: request });
    return applyWorkspaceCommand(initial, request).layout;
  }
  function commit(initial, id, source, destination) {
    let layout = step(
      `${id} ready`,
      initial,
      { type: "transfer-ready", transferId: id },
      destination,
    );
    layout = step(
      `${id} restored`,
      layout,
      { type: "transfer-state-ready", transferId: id },
      destination,
    );
    return step(
      `${id} commit`,
      layout,
      { type: "commit-transfer", transferId: id },
      source,
    );
  }
  for (const scenario of [
    "whole-inactive",
    "single-return",
    "direct",
    "occupied",
    "added-rail",
    "converted-rail",
    "rail-added-slot",
  ]) {
    let layout = direct;
    if (scenario === "whole-inactive")
      layout = step("inactive slot", layout, {
        type: "select",
        tabId: "terminal",
      });
    layout = step(`${scenario} prepare`, layout, {
      type: "prepare-detach",
      transferId: "detach",
      paneId: "pane",
      ...(scenario === "whole-inactive" || scenario === "single-return"
        ? {}
        : {
            tabId: scenario === "rail-added-slot" ? "terminal" : "conversation",
          }),
      destinationWindowId: "popout",
      destinationPaneId:
        scenario === "whole-inactive" || scenario === "single-return"
          ? "pane"
          : "detached",
    });
    layout = commit(layout, "detach", "main", "popout");
    if (scenario === "occupied")
      layout = step("replace old slot", layout, {
        ...open,
        view: view("intervening"),
      });
    if (scenario === "added-rail")
      layout = step(
        "add detached rail",
        layout,
        {
          type: "open",
          tab: view("extra", "project.terminal"),
          target: { kind: "pane", paneId: "detached" },
        },
        "popout",
      );
    if (scenario === "converted-rail")
      layout = step(
        "convert detached slot",
        layout,
        {
          type: "move",
          tabId: "conversation",
          targetPaneId: "detached",
          position: 0,
        },
        "popout",
      );
    if (scenario === "rail-added-slot")
      layout = step(
        "add detached slot",
        layout,
        { ...open, view: view("extra") },
        "popout",
      );
    layout = step(
      `${scenario} prepare return`,
      layout,
      {
        type: "prepare-return",
        transferId: "return",
        paneId:
          scenario === "whole-inactive" || scenario === "single-return"
            ? "pane"
            : "detached",
        ...(scenario === "single-return"
          ? { tabId: "conversation", destinationPaneId: "returned-single" }
          : {}),
        splitId: "return-split",
      },
      "popout",
    );
    commit(layout, "return", "popout", "main");
  }
}

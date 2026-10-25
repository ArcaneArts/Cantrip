import { expect, it } from "vitest";
import { importWorkspaceLegacyFiles } from "../src/workspace-legacy-file-import.js";
import {
  workspaceOwnershipSchema,
  workspaceLegacyFileImportSchema,
} from "../src/workspace-ownership.js";

const initial = () =>
  workspaceOwnershipSchema.parse({
    version: 1,
    id: "workspace",
    projectId: "project",
    revision: 0,
    mainWindowId: "main",
    windows: [
      {
        id: "main",
        attachmentGeneration: 0,
        panes: [],
        centerRoot: null,
        focusedPaneId: null,
        recentPaneIds: [],
      },
    ],
  });
const request = () =>
  workspaceLegacyFileImportSchema.parse({
    windowId: "cantrip-editor-legacy",
    paneId: "legacy-pane",
    views: [
      { tabId: "view-a", documentId: "document-a", mode: "edit" },
      { tabId: "view-b", documentId: "document-b", mode: "preview" },
    ],
  });
const titles = () =>
  new Map([
    ["document-a", null],
    ["document-b", null],
  ]);

it("imports ordered independent file views without changing main or the input", () => {
  const source = initial();
  const result = importWorkspaceLegacyFiles(source, request(), titles());
  expect(result.replayed).toBe(false);
  expect(source.windows).toHaveLength(1);
  expect(result.layout.windows[0]).toEqual(source.windows[0]);
  expect(
    result.layout.windows[1]!.panes[0]!.tabs.map((tab) => [
      tab.id,
      tab.fileMode,
    ]),
  ).toEqual([
    ["view-a", "edit"],
    ["view-b", "preview"],
  ]);
  expect(result.layout.revision).toBe(1);
});

it("replays the same import without resurrecting a subsequently closed window", () => {
  const first = importWorkspaceLegacyFiles(
    initial(),
    request(),
    titles(),
  ).layout;
  first.windows = first.windows.filter(({ id }) => id === "main");
  first.revision = 8;
  const replay = importWorkspaceLegacyFiles(first, request(), titles());
  expect(replay).toEqual({ layout: first, replayed: true });
});

it("rejects reusing an import identity for different document bindings", () => {
  const first = importWorkspaceLegacyFiles(
    initial(),
    request(),
    titles(),
  ).layout;
  const changed = request();
  changed.views[0]!.documentId = "other";
  expect(() => importWorkspaceLegacyFiles(first, changed, titles())).toThrow(
    "different views",
  );
});

it("rejects missing authorization without importing partial state", () => {
  expect(() =>
    importWorkspaceLegacyFiles(
      initial(),
      request(),
      new Map([["document-a", null]]),
    ),
  ).toThrow("unavailable");
});

it("rejects a duplicate owned document rather than overwriting its view", () => {
  const first = importWorkspaceLegacyFiles(
    initial(),
    request(),
    titles(),
  ).layout;
  const second = request();
  second.windowId = "cantrip-editor-other";
  second.paneId = "other-pane";
  expect(() => importWorkspaceLegacyFiles(first, second, titles())).toThrow(
    "already has an owned view",
  );
});

it.each(["main", "cantrip-pane-workspace-other", "cantrip-editor-"])(
  "rejects non-legacy window identity %s",
  (windowId) => {
    expect(
      workspaceLegacyFileImportSchema.safeParse({ ...request(), windowId })
        .success,
    ).toBe(false);
  },
);

it("rejects repeated document bindings and view identity collisions", () => {
  const repeated = request();
  repeated.views[1]!.documentId = repeated.views[0]!.documentId;
  expect(() =>
    importWorkspaceLegacyFiles(initial(), repeated, titles()),
  ).toThrow("repeats a document");
  const colliding = request();
  colliding.views[1]!.tabId = colliding.views[0]!.tabId;
  expect(() =>
    importWorkspaceLegacyFiles(initial(), colliding, titles()),
  ).toThrow();
});

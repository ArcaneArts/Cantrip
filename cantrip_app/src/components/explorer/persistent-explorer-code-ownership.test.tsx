// @vitest-environment jsdom
import type { ExplorerSummary } from "@cantrip/protocol";
import type { EditorDocumentSession } from "@/components/editor/document-session";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, useEffect } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const owners = vi.hoisted(() => ({
  created: [] as string[],
  released: [] as string[],
  code: [] as string[],
  sessions: new Map<string, EditorDocumentSession>(),
}));
vi.mock("@/components/editor/native-code-editor", () => ({
  NativeCodeEditor: ({
    session,
    path,
    active,
    onChange,
  }: {
    session: EditorDocumentSession;
    path: string;
    active: boolean;
    onChange(text: string): void;
  }) => {
    owners.sessions.set(path, session);
    useEffect(() => {
      owners.created.push(path);
      return () => {
        owners.released.push(path);
      };
    }, [session, path]);
    return createElement("div", {
      "data-native-path": path,
      "data-active": active,
      onChange,
    });
  },
}));
vi.mock("@/components/explorer/retained-explorer-code-editor", () => ({
  RetainedExplorerCodeEditor: ({ path }: { path: string }) => {
    useEffect(() => {
      owners.code.push(path);
    }, [path]);
    return createElement("div", { "data-vscode-path": path });
  },
}));
vi.mock("@/components/chat/markdown", () => ({
  Markdown: () => createElement("div"),
}));
vi.mock("@/components/explorer/explorer-file-browser", () => ({
  ExplorerFileBrowser: () => createElement("div"),
}));
vi.mock("@/components/explorer/explorer-image-viewport", () => ({
  ExplorerImageViewport: () => createElement("div"),
}));
vi.mock("@/components/explorer/use-explorer-worker-encryption", () => ({
  useExplorerWorkerEncryption: (_explorer: unknown, enabled: boolean) => ({
    bindingKey: "binding-one",
    error: null,
    ready: enabled,
    retry: vi.fn(),
  }),
}));
vi.mock("@/components/git/git-graph", () => ({
  GitRepositoryGraphView: () => createElement("div"),
}));
vi.mock("@/lib/api", () => ({
  getExplorerFile: vi.fn(async (_id: string, path: string) => ({
    path,
    content: `const file = '${path}';`,
    version: "one",
    markdown: false,
  })),
  loadExplorerMedia: vi.fn(),
  saveExplorerFile: vi.fn(),
  updateExplorerViewState: vi.fn(),
}));
vi.mock("@/lib/client-log-relay", () => ({
  clientLogger: { info: vi.fn(), warn: vi.fn() },
}));
import { PersistentExplorerViews } from "./persistent-explorer-views";
import type { ExplorerHeaderState } from "./explorer-view";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function explorer(id: string, selectedPath: string | null): ExplorerSummary {
  return {
    activeWorkerId: "worker-one",
    fileMode: "edit",
    id,
    projectId: "project-one",
    selectedPath,
    title: id,
    worktreeId: "worktree-one",
  } as ExplorerSummary;
}
function view(
  client: QueryClient,
  activeExplorer: ExplorerSummary,
  openExplorers: ExplorerSummary[],
  prewarmExplorer: ExplorerSummary | null = null,
  prewarmSuccessorExplorer: ExplorerSummary | null = null,
  onHeaderChange?: (header: ExplorerHeaderState | null) => void,
) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(PersistentExplorerViews, {
      activeExplorer,
      appearance: "dark",
      gitStatuses: {},
      openExplorers,
      prewarmExplorer,
      prewarmSuccessorExplorer,
      repositoryGraphAvailable: false,
      onHeaderChange,
    }),
  );
}
const createClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });

async function mounted(
  first: ExplorerSummary,
  opened: ExplorerSummary[],
  prewarm: ExplorerSummary | null = null,
  successor: ExplorerSummary | null = null,
  onHeader?: (header: ExplorerHeaderState | null) => void,
) {
  const client = createClient();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      view(client, first, opened, prewarm, successor, onHeader),
    );
  });
  await settle();
  return {
    client,
    renderer,
    async update(
      active: ExplorerSummary,
      open: ExplorerSummary[],
      warm: ExplorerSummary | null = null,
    ) {
      await act(async () =>
        renderer.update(view(client, active, open, warm, null, onHeader)),
      );
      await settle();
    },
    async close() {
      await act(async () => renderer.unmount());
      client.clear();
    },
  };
}

describe("Persistent Explorer native ownership and explicit VS Code", () => {
  beforeEach(() => {
    owners.created.length = 0;
    owners.released.length = 0;
    owners.code.length = 0;
    owners.sessions.clear();
  });
  it("loads open documents without starting workbenches for empty prewarm owners", async () => {
    const first = explorer("first", "src/first.ts"),
      second = explorer("second", "src/second.ts");
    const state = await mounted(
      first,
      [first, second],
      explorer("prewarm", null),
      explorer("successor", null),
    );
    expect(owners.created).toEqual([first.selectedPath, second.selectedPath]);
    expect(owners.code).toEqual([]);
    expect(owners.released).toEqual([]);
    expect(
      state.renderer.root.findAllByProps({
        "data-native-path": second.selectedPath,
      }),
    ).toHaveLength(1);
    await state.close();
  });
  it("promotes an empty Explorer to a native document without creating a Code runtime", async () => {
    const first = explorer("first", "src/first.ts"),
      empty = explorer("prewarm", null),
      promoted = explorer("prewarm", "src/promoted.ts");
    const state = await mounted(first, [first], empty);
    await state.update(promoted, [first, promoted], promoted);
    const input = state.renderer.root.findByProps({
      "data-native-path": promoted.selectedPath,
    });
    await state.update(promoted, [first, promoted], promoted);
    expect(
      state.renderer.root.findByProps({
        "data-native-path": promoted.selectedPath,
      }),
    ).toBe(input);
    expect(owners.created).toEqual([first.selectedPath, promoted.selectedPath]);
    expect(owners.code).toEqual([]);
    expect(owners.released).toEqual([]);
    await state.close();
  });
  it("creates an inactive document exactly once when first activated", async () => {
    const first = explorer("first", "src/first.ts"),
      second = explorer("second", "src/second.ts");
    const state = await mounted(first, [first, second]);
    await state.update(second, [first, second]);
    await state.update(second, [first, second]);
    expect(owners.created).toEqual([first.selectedPath, second.selectedPath]);
    expect(owners.released).toEqual([]);
    expect(owners.code).toEqual([]);
    expect(
      state.renderer.root.findByProps({
        "data-native-path": first.selectedPath,
      }).props["data-active"],
    ).toBe(false);
    expect(
      state.renderer.root.findByProps({
        "data-native-path": second.selectedPath,
      }).props["data-active"],
    ).toBe(true);
    await state.close();
  });
  it("keeps the same dirty document session, selection, and undo history while inactive", async () => {
    const first = explorer("first", "src/first.ts"),
      second = explorer("second", "src/second.ts");
    const state = await mounted(first, [first, second]);
    const session = owners.sessions.get(first.selectedPath!)!;
    const before = session.text,
      position = { start: 3, end: 3, direction: "none" as const };
    await act(async () => {
      session.history.record(before, "draft", position, position);
      session.edit("draft");
      session.selection = position;
      state.renderer.root
        .findByProps({ "data-native-path": first.selectedPath })
        .props.onChange("draft");
    });
    await state.update(second, [first, second]);
    await state.update(first, [first, second]);
    expect(owners.sessions.get(first.selectedPath!)).toBe(session);
    expect(session.text).toBe("draft");
    expect(session.dirty).toBe(true);
    expect(session.selection).toEqual(position);
    expect(session.history.undo(session.text)?.text).toBe(before);
    expect(owners.released).toEqual([]);
    expect(owners.code).toEqual([]);
    await state.close();
  });
  it("releases an inactive clean document only when its owning tab closes", async () => {
    const first = explorer("first", "src/first.ts"),
      second = explorer("second", "src/second.ts");
    const state = await mounted(first, [first, second]);
    await state.update(second, [first, second]);
    await state.update(second, [second]);
    expect(owners.created).toEqual([first.selectedPath, second.selectedPath]);
    expect(owners.released).toEqual([first.selectedPath]);
    expect(
      state.renderer.root.findAllByProps({
        "data-native-path": first.selectedPath,
      }),
    ).toHaveLength(0);
    expect(
      state.renderer.root.findByProps({
        "data-native-path": second.selectedPath,
      }).props["data-active"],
    ).toBe(true);
    await state.close();
  });
  it("creates a workbench only after the explicit Open in VS Code action", async () => {
    const first = explorer("first", "src/first.ts");
    let header: ExplorerHeaderState | null = null;
    const state = await mounted(first, [first], null, null, (value) => {
      header = value;
    });
    expect(owners.code).toEqual([]);
    await act(async () => header!.openInVsCode!());
    await settle();
    expect(owners.code).toEqual([first.selectedPath]);
    await state.close();
  });
});

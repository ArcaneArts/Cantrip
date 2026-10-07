import type { ChatFileReferencesResult } from "@cantrip/protocol/surface-stream";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  MessageFileSummary,
  type MessageFileEntry,
  type MessageFileSummaryModel,
} from "./message-file-summary";
import {
  messageFileTree,
  messageFileTreeCounts,
  type MessageFileTreeNode,
} from "./message-file-tree";

function entry(path: string): MessageFileEntry {
  return {
    path,
    reference: path,
    additions: null,
    deletions: null,
    edited: false,
    referenced: true,
  };
}

function paths(node: MessageFileTreeNode): string[] {
  return [node.path, ...node.children.flatMap(paths)];
}

describe("referenced file directory tree", () => {
  it("uses the deepest common parent and merges referenced folders with their descendants", () => {
    const root = messageFileTree([
      entry("/repo/common"),
      entry("/repo/native"),
      entry("/repo/common/src/Terrain.java"),
      entry("/repo/common/src/Generator.java"),
      entry("/repo/native/src/lib.rs"),
      entry("/repo/docs/PROTOCOL.md"),
    ])!;
    expect(root.path).toBe("/repo");
    expect(root.children.map((child) => child.name)).toEqual([
      "common",
      "docs",
      "native",
    ]);
    expect(root.children[0]!.kind).toBe("directory");
    expect(root.children[0]!.entry?.reference).toBe("/repo/common");
    expect(paths(root).filter((path) => path === "/repo/common")).toHaveLength(
      1,
    );
    expect(messageFileTreeCounts(root)).toEqual({ files: 4, folders: 2 });
  });

  it("starts at the files' parent rather than the project root", () => {
    const root = messageFileTree([
      entry("src/deep/app.ts"),
      entry("src/deep/LICENSE"),
    ])!;
    expect(root.path).toBe("src/deep");
    expect(root.children.map((child) => child.name)).toEqual([
      "app.ts",
      "LICENSE",
    ]);
    expect(messageFileTree([entry("README")])!.path).toBe(".");
    expect(messageFileTree([])).toBeNull();
  });

  it("uses metadata for dotted folders and extensionless files, and unifies relative and absolute paths", () => {
    const entries = [
      entry("folder.ext"),
      entry("/repo/LICENSE"),
      entry("src/app.ts:12"),
    ];
    const metadata: ChatFileReferencesResult = {
      root: "/repo",
      entries: [
        {
          reference: "folder.ext",
          path: "/repo/folder.ext",
          kind: "directory",
        },
        { reference: "/repo/LICENSE", path: "/repo/LICENSE", kind: "file" },
        { reference: "src/app.ts:12", path: "/repo/src/app.ts", kind: "file" },
        {
          reference: "unreferenced.txt",
          path: "/repo/unreferenced.txt",
          kind: "file",
        },
      ],
    };
    const root = messageFileTree(entries, metadata)!;
    expect(root.path).toBe("/repo");
    expect(
      root.children.find((child) => child.name === "folder.ext")?.kind,
    ).toBe("directory");
    expect(root.children.find((child) => child.name === "LICENSE")?.kind).toBe(
      "file",
    );
    expect(paths(root)).not.toContain("/repo/unreferenced.txt");
    expect(paths(root)).toContain("/repo/src/app.ts");
    expect(messageFileTreeCounts(root)).toEqual({ files: 2, folders: 1 });
  });

  it.each([
    ["C:\\Repo\\src\\app.ts:12", "c:/repo/src/util.ts#L8", "C:/Repo/src"],
    [
      "//server/share/repo/a.ts",
      "//server/share/repo/b.ts",
      "//server/share/repo",
    ],
    ["/a.ts", "/b.ts", "/"],
  ])(
    "handles platform roots and source locations (%s)",
    (left, right, expected) => {
      const root = messageFileTree([entry(left), entry(right)])!;
      expect(root.path).toBe(expected);
      expect(root.children).toHaveLength(2);
    },
  );

  it("keeps references from different drives when there is no shared filesystem parent", () => {
    const root = messageFileTree([
      entry("C:/repo/a.ts"),
      entry("D:/other/b.ts"),
    ])!;
    expect(root.name).toBe("Referenced paths");
    expect(paths(root)).toContain("C:/repo/a.ts");
    expect(paths(root)).toContain("D:/other/b.ts");
  });

  it("does not discard missing paths or confuse sibling name prefixes", () => {
    const root = messageFileTree(
      [entry("/repo/src"), entry("/repo/src-old/app.ts")],
      {
        root: "/repo",
        entries: [{ reference: "/repo/src", path: "/repo/src", kind: null }],
      },
    )!;
    expect(paths(root)).toContain("/repo/src");
    expect(root.children.find((child) => child.name === "src")?.kind).toBe(
      "file",
    );
  });

  it("expands folders locally and opens only file leaves with their original reference", async () => {
    const onOpenFile = vi.fn();
    const model: MessageFileSummaryModel = {
      title: "Files Referenced",
      additions: 0,
      deletions: 0,
      entries: [
        entry("/repo/src/module/app.ts:12"),
        entry("/repo/src/README.md"),
        entry("/repo/docs/start.md"),
      ],
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MessageFileSummary model={model} onOpenFile={onOpenFile} />,
      );
    });
    const button = (title: string) =>
      renderer.root.find(
        (node) => node.type === "button" && node.props.title === title,
      );
    expect(button("/repo").props["aria-expanded"]).toBe(true);
    expect(button("/repo/src").props["data-file-kind"]).toBe("directory");
    expect(button("/repo/src").props["aria-expanded"]).toBe(false);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("app.ts");
    await act(async () => button("/repo/src").props.onClick());
    await act(async () => button("/repo/src/module").props.onClick());
    expect(onOpenFile).not.toHaveBeenCalled();
    await act(async () => button("/repo/src/module/app.ts").props.onClick());
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(
      "/repo/src/module/app.ts:12",
    );
    await act(async () => button("/repo/src").props.onClick());
    expect(JSON.stringify(renderer.toJSON())).not.toContain("app.ts");
    await act(async () => renderer.unmount());
  });

  it("renders a folder with no referenced descendants as an expandable folder rather than an editor link", () => {
    const model: MessageFileSummaryModel = {
      title: "Files Referenced",
      additions: 0,
      deletions: 0,
      entries: [entry("/repo/fabric")],
    };
    const markup = renderToStaticMarkup(
      <MessageFileSummary
        model={model}
        metadata={{
          root: "/repo",
          entries: [
            {
              reference: "/repo/fabric",
              path: "/repo/fabric",
              kind: "directory",
            },
          ],
        }}
        onOpenFile={vi.fn()}
      />,
    );
    expect(markup).toContain('data-file-kind="directory"');
    expect(markup).not.toContain('data-file-kind="file"');
    expect(markup).toContain("No referenced files in this folder.");
    expect(markup).toContain("0 files · 1 folder");
  });
});

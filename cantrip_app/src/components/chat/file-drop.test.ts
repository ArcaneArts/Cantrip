import { describe, expect, it } from "vitest";

import {
  dataTransferHasFiles,
  filesFromDataTransfer,
} from "@/components/chat/file-drop";

function dataTransfer({
  files = [],
  itemKinds = [],
  types = [],
}: {
  files?: File[];
  itemKinds?: DataTransferItem["kind"][];
  types?: string[];
}): DataTransfer {
  return {
    files,
    items: itemKinds.map((kind) => ({ kind })),
    types,
  } as unknown as DataTransfer;
}

describe("chat file drop", () => {
  it("detects desktop file drags from the Files transfer type", () => {
    expect(dataTransferHasFiles(dataTransfer({ types: ["Files"] }))).toBe(true);
  });

  it("detects file items when a desktop webview omits the Files type", () => {
    expect(dataTransferHasFiles(dataTransfer({ itemKinds: ["file"] }))).toBe(
      true,
    );
  });

  it("ignores non-file drags", () => {
    expect(
      dataTransferHasFiles(
        dataTransfer({ itemKinds: ["string"], types: ["text/plain"] }),
      ),
    ).toBe(false);
  });

  it("returns one dropped file", () => {
    const file = new File(["one"], "one.txt", { type: "text/plain" });

    expect(filesFromDataTransfer(dataTransfer({ files: [file] }))).toEqual([
      file,
    ]);
  });

  it("returns multiple dropped files in their original order", () => {
    const first = new File(["one"], "one.txt", { type: "text/plain" });
    const second = new File(["two"], "two.md", { type: "text/markdown" });

    expect(
      filesFromDataTransfer(dataTransfer({ files: [first, second] })),
    ).toEqual([first, second]);
  });
});

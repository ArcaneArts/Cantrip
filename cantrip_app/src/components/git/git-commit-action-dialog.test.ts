import { describe, expect, it } from "vitest";

import {
  commitActionFromEditor,
  type CommitActionEditor,
  type CommitActionRequest,
} from "./git-commit-action-dialog";

const hash = "1".repeat(40);
const target = {
  hash,
  shortHash: hash.slice(0, 8),
  subject: "Selected commit",
  parents: ["2".repeat(40), "3".repeat(40)],
  isHead: false,
};
const editor: CommitActionEditor = {
  range: false,
  fromRevision: hash,
  toRevision: hash,
  mainlineParent: 1,
  message: "",
};

describe("commit action dialog", () => {
  it("builds inclusive range and single cherry-pick actions", () => {
    const request: CommitActionRequest = { kind: "cherryPick", target };
    expect(commitActionFromEditor(request, editor)).toEqual({
      type: "cherryPick",
      selection: { type: "commits", revisions: [hash] },
    });
    expect(
      commitActionFromEditor(request, {
        ...editor,
        range: true,
        fromRevision: "4".repeat(40),
        toRevision: "5".repeat(40),
      }),
    ).toEqual({
      type: "cherryPick",
      selection: {
        type: "range",
        fromRevision: "4".repeat(40),
        toRevision: "5".repeat(40),
      },
    });
  });

  it("keeps merge mainline and optional amend message explicit", () => {
    expect(
      commitActionFromEditor({ kind: "revert", target }, editor),
    ).toMatchObject({
      type: "revert",
      revision: hash,
      mainlineParent: 1,
    });
    expect(
      commitActionFromEditor(
        { kind: "amend", target: { ...target, isHead: true } },
        { ...editor, message: "  Revised message  " },
      ),
    ).toEqual({ type: "amend", message: "Revised message" });
  });
});

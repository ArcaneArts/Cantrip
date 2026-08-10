import { describe, expect, it } from "vitest";

import {
  parseConflictMarkerSections,
  resolveConflictMarkerSection,
} from "./git-conflict-resolver";

describe("Git conflict marker editing", () => {
  const conflict = [
    "before\n",
    "<<<<<<< HEAD\n",
    "ours\n",
    "||||||| base\n",
    "base\n",
    "=======\n",
    "theirs\n",
    ">>>>>>> feature\n",
    "after\n",
  ].join("");

  it("parses diff3 conflict blocks without treating base as ours", () => {
    expect(parseConflictMarkerSections(conflict)).toEqual([
      expect.objectContaining({ ours: "ours\n", theirs: "theirs\n" }),
    ]);
  });

  it("replaces one block while preserving surrounding result text", () => {
    const section = parseConflictMarkerSections(conflict)[0];
    expect(resolveConflictMarkerSection(conflict, section!, "both")).toBe(
      "before\nours\ntheirs\nafter\n",
    );
  });

  it("ignores incomplete conflict markers", () => {
    expect(parseConflictMarkerSections("<<<<<<< HEAD\nours\n")).toEqual([]);
  });
});

import { expect, it } from "vitest";
import { JAVA_NBT } from "@cantrip/nbt";
import {
  nbtViewMatches,
  validateNbtViewState,
  type NbtViewState,
} from "./view-state";
import type { NbtDocumentStatus } from "@cantrip/nbt/document";

export const viewState = (): NbtViewState => ({
  viewer: "nbt",
  version: 1,
  baselineVersion: "original-v1",
  format: { ...JAVA_NBT },
  profile: "java",
  compression: "none",
  expanded: ["node:0", "node:1"],
  selected: "node:2",
  target: "node:3",
  mode: "array",
  editing: true,
  findOpen: true,
  tree: { position: 950000000.25, rank: 950000005 },
  array: { firstElement: 1000000000, hex: true },
  table: {
    position: 125.5,
    scrollLeft: 240,
    columnOffset: 8,
    reference: 300,
    reverse: true,
  },
  find: {
    text: "needle",
    fields: ["name", "value"],
    exactNumber: false,
    caseSensitive: true,
    scope: "node:1",
    rank: 42,
  },
});
it("copies sparse typed view state without retaining unknown parsed data or caller arrays", () => {
  const original = viewState(),
    decoded = validateNbtViewState({
      ...original,
      parsedDocument: { secret: "not-transfer-data" },
    });
  expect(decoded).toEqual(original);
  expect(decoded).not.toHaveProperty("parsedDocument");
  original.expanded.push("node:4");
  original.find!.fields.push("type");
  original.format.endian = "little";
  expect(decoded.expanded).toEqual(["node:0", "node:1"]);
  expect(decoded.find!.fields).toEqual(["name", "value"]);
  expect(decoded.format.endian).toBe("big");
});
it.each([
  (state: NbtViewState) => {
    state.tree.position = Infinity;
  },
  (state: NbtViewState) => {
    state.array!.firstElement = -1;
  },
  (state: NbtViewState) => {
    state.table!.reference = 0.5;
  },
  (state: NbtViewState) => {
    state.find!.rank = -2;
  },
  (state: NbtViewState) => {
    state.format.namedRoot = "false" as unknown as boolean;
  },
  (state: NbtViewState) => {
    state.expanded.push(42 as unknown as string);
  },
  (state: NbtViewState) => {
    state.version = 2 as 1;
  },
])("rejects malformed transferred view state", (change) => {
  const state = viewState();
  change(state);
  expect(() => validateNbtViewState(state)).toThrow(/Invalid NBT/);
});
it("keeps original parser identity across journal generations and rejects fresh parses/encoding changes", () => {
  const state = viewState(),
    status = {
      baselineVersion: state.baselineVersion,
      format: state.format,
      shared: { generation: 200, views: 2, changing: false },
    } as NbtDocumentStatus;
  expect(nbtViewMatches(state, status)).toBe(true);
  expect(
    nbtViewMatches(state, { ...status, baselineVersion: "saved-v2" }),
  ).toBe(false);
  expect(
    nbtViewMatches(state, {
      ...status,
      format: { ...state.format, namedRoot: false },
    }),
  ).toBe(false);
  expect(nbtViewMatches(state, { ...status, format: undefined })).toBe(false);
});

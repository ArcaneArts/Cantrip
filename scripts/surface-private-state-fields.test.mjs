import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { guestDesktopAdmissionFieldRanges } from "./surface-private-state-fields.mjs";

const imports = `
import { cantripOsDesktopWorkerCommandSchema as desktop } from "@cantrip/protocol";
import * as schema from "../schema.js";
const operations = schema.cantripOsDesktopOperations;
export type Row = typeof operations.$inferSelect;
`;
const creation = `desktop.parse({type:"cantrip-os.desktop.operation", desktopTarget: target.snapshot});`;
const read = `function record(original: Row) { return original.command.desktopTarget; }`;
const unclassified = (source) => {
  const ranges = guestDesktopAdmissionFieldRanges(source);
  return [...source.matchAll(/\bdesktopTarget\b/gu)].filter(
    (match) =>
      !ranges.some(([start, end]) => match.index >= start && match.index < end),
  ).length;
};

test("classifies only the schema-bound guest admission references", () => {
  assert.equal(unclassified(imports + creation + read), 0);
  assert.equal(
    unclassified(imports + creation + read + "request.body.desktopTarget;"),
    1,
  );
});

for (const [label, source] of [
  [
    "unvalidated object",
    'const command = {type:"cantrip-os.desktop.operation",desktopTarget:target};',
  ],
  [
    "other discriminator",
    creation.replace("cantrip-os.desktop.operation", "surface.desktop.open"),
  ],
  [
    "other schema import",
    (imports + creation).replace("@cantrip/protocol", "./fake.js"),
  ],
  ["shadowed schema", imports + `function f(desktop) { ${creation} }`],
  ["untyped row", imports + read.replace(": Row", "")],
  [
    "reassigned row",
    imports +
      read.replace(
        "return original",
        "original = remoteSurface; return original",
      ),
  ],
  [
    "other table",
    (imports + read).replace(
      "schema.cantripOsDesktopOperations",
      "schema.remoteSurfaces",
    ),
  ],
  [
    "other schema namespace",
    (imports + read).replace("../schema.js", "./fake.js"),
  ],
  [
    "local type alias",
    imports +
      `function record(original: Row) { type Row = {command:any}; return original.command.desktopTarget; }`,
  ],
  [
    "generic type shadow",
    imports +
      `function record<Row>(original: Row) { return original.command.desktopTarget; }`,
  ],
  [
    "private surface in guest repository",
    imports +
      `function record(original: Row) { return original.command.surface.desktopTarget; }`,
  ],
]) {
  test(`retains the protected-field finding for ${label}`, () => {
    assert.equal(unclassified(source), 1);
  });
}

test("classifies both real repository references without exempting the file", async () => {
  const source = await readFile(
    new URL(
      "../cantrip_server/src/db/repository/cantrip-os-desktop.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(guestDesktopAdmissionFieldRanges(source).length, 2);
  assert.equal(unclassified(source), 0);
  assert.equal(unclassified(source + "\nremoteSurface.desktopTarget;"), 1);
});

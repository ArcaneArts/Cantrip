import assert from "node:assert/strict";
import test from "node:test";
import { createLogicalCreditProbe } from "./editor-logical-credit.mjs";

const route = {
  tunnelId: "tunnel",
  attachmentId: "attachment",
  sourceEndpointId: "source",
  destinationEndpointId: "destination",
  connectionId: "bulk",
};
const bulk = "http://fixture.localhost/workbench.js?qaBulk=1";

test("logical credit selection leaves unarmed and sibling requests untouched", () => {
  const probe = createLogicalCreditProbe();
  probe.select(bulk, "bulk", 256, () => route);
  assert.equal(probe.withhold("bulk", 64), false);
  probe.arm();
  probe.select(
    "http://fixture.localhost/workbench.js?qaControl=1",
    "control",
    256,
    () => route,
  );
  assert.equal(probe.snapshot().selected, null);
  probe.select(bulk, "bulk", 256, () => route);
  probe.select(bulk, "sibling", 256, () => ({
    ...route,
    connectionId: "sibling",
  }));
  probe.received("sibling", 1_024);
  assert.equal(probe.withhold("sibling", 1_024), false);
  probe.received("bulk", 128);
  assert.equal(probe.withhold("bulk", 128), true);
  assert.equal(probe.snapshot().receivedBytes, 128);
  assert.equal(probe.snapshot().withheldBytes, 128);
  assert.equal(probe.snapshot().selected, "bulk");
});

test("retirement is recorded only for the selected logical connection", () => {
  const probe = createLogicalCreditProbe();
  probe.arm();
  probe.select(bulk, "bulk", 256, () => route);
  probe.retired("sibling");
  assert.equal(probe.snapshot().retired, false);
  probe.retired("bulk");
  assert.equal(probe.snapshot().retired, true);
});

test("the snapshot exposes authority replacement instead of treating it as continuity", () => {
  const probe = createLogicalCreditProbe();
  let current = route;
  probe.arm();
  probe.select(bulk, "bulk", 256, () => current);
  current = { ...route, attachmentId: "replacement" };
  assert.notDeepEqual(
    probe.snapshot().identity,
    probe.snapshot().currentIdentity,
  );
});

test("a released selection drops its reference and a later run starts clean", () => {
  const probe = createLogicalCreditProbe();
  probe.arm();
  probe.select(bulk, "bulk", 256, () => route);
  probe.received("bulk", 256);
  probe.withhold("bulk", 256);
  assert.throws(() => probe.arm(), /still owned/);
  probe.release();
  assert.equal(probe.withhold("bulk", 64), false);
  assert.equal(probe.snapshot().currentIdentity, null);
  probe.arm();
  assert.equal(probe.snapshot().receivedBytes, 0);
  assert.equal(probe.snapshot().withheldCredits, 0);
  assert.equal(probe.snapshot().retired, false);
});

// Account for real publications on independently timed server processes. Never
// discard a ready cursor: prove it against a retained, contiguous socket stream.
import assert from "node:assert/strict";
import { LiveProbe, currentUser } from "./live-sockets.mjs";

export class LiveCursorObserver {
  constructor(fixture) {
    this.fixture = fixture;
    this.publications = [];
    this.processed = 0;
  }
  async open() {
    this.startedAt = Date.now();
    const snapshot = await new LiveProbe(this.fixture).open();
    try {
      this.baseline = await snapshot.initialized();
    } finally {
      await snapshot.close();
    }
    this.cursor = this.baseline.currentCursor;
    this.probe = await new LiveProbe(this.fixture).open();
    // Resume closes the race between taking a snapshot and installing scopes.
    const ready = await this.probe.initialized({
      serverEpoch: this.baseline.serverEpoch,
      cursor: this.cursor,
    });
    await this.probe.subscribed("cursor-observer", [currentUser]);
    await this.verifyFrame(await this.probe.ping("observer-installed"));
    await this.verifyFrame(ready);
    return this;
  }
  collect() {
    for (; this.processed < this.probe.history.length; this.processed++) {
      const event = this.probe.history[this.processed];
      if (event.type !== "event") continue;
      const { cursor, occurredAt, ...body } = event;
      // JSON inputs do not mutate resources. Only separately scheduled usage
      // publications are permitted here; their missing native domain remains
      // explicit in the coverage ledger and raw report, never a parity claim.
      assert.deepEqual(body, {
        type: "event",
        scope: currentUser,
        resource: "account-resource-usage",
        action: "invalidated",
        entityId: null,
        revision: null,
        payload: null,
      });
      assert.equal(new Date(occurredAt).toISOString(), occurredAt);
      assert.ok(Date.parse(occurredAt) >= this.startedAt - 1000);
      assert.ok(Date.parse(occurredAt) <= Date.now() + 1000);
      const duplicate = this.publications.find(
        (value) => value.cursor === cursor,
      );
      if (duplicate) {
        assert.deepEqual(
          event,
          duplicate,
          "Replayed ordinals retain the same event",
        );
        continue;
      }
      assert.equal(cursor, this.cursor + 1, "Contiguous publication cursors");
      this.cursor = cursor;
      this.publications.push(event);
    }
  }
  async waitForPublication() {
    this.collect();
    if (!this.publications.length) {
      await this.probe.message((frame) => frame.type === "event");
      this.collect();
    }
    assert.ok(
      this.publications.length,
      "Actual usage publication reached the observer",
    );
    return this.publications[0];
  }
  beforeSend() {
    this.collect();
    return this.cursor;
  }
  async initialized(probe) {
    const minimum = this.beforeSend();
    return this.verifyFrame(await probe.initialized(), minimum);
  }
  async verifyFrame(frame, minimum = this.baseline.currentCursor) {
    assert.ok(["ready", "pong"].includes(frame.type));
    if (frame.type === "ready")
      assert.equal(frame.serverEpoch, this.baseline.serverEpoch);
    const cursor = frame.type === "ready" ? frame.currentCursor : frame.cursor;
    assert.ok(
      Number.isSafeInteger(cursor) && cursor >= this.baseline.currentCursor,
    );
    assert.ok(
      cursor >= minimum,
      "Cursor includes publications observed before this request",
    );
    this.collect();
    if (this.cursor < cursor) {
      await this.probe.message(
        (value) => value.type === "event" && value.cursor >= cursor,
      );
      this.collect();
    }
    const count = this.publications.filter(
      (event) => event.cursor <= cursor,
    ).length;
    assert.equal(
      cursor,
      this.baseline.currentCursor + count,
      "Frame cursor equals baseline plus actual observed publications",
    );
    return {
      rawCurrentCursor: cursor,
      baselineCursor: this.baseline.currentCursor,
      observedBeforeRequest: minimum,
      accountedUsagePublications: count,
      parserPublications: cursor - this.baseline.currentCursor - count,
    };
  }
  async close() {
    if (!this.closing)
      this.closing = (async () => {
        await this.probe?.close();
        if (this.probe) this.collect();
        return {
          baseline: this.baseline,
          publications: this.publications,
          lastObservedCursor: this.cursor,
        };
      })();
    return this.closing;
  }
}

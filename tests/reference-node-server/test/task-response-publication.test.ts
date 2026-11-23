import { describe, expect, it } from "vitest";
import { taskResponsePublicationKind } from "../src/db/task-response-publication.js";
import type { TaskMessageOpaqueContent } from "@cantrip/protocol/tasks";

const publication = { id: "assigned", idempotencyKey: "assistant:input" };
const execution = { threadId: "thread", turnId: "turn" };
const message = (key: string, id = "streamed") =>
  ({ id, idempotencyKey: key }) as TaskMessageOpaqueContent;

describe("Task response publication identity", () => {
  it("matches unpaired UTF-16 units without treating replacement characters as equal", () => {
    const native = { threadId: "t\ud800", turnId: "v\udfff" };
    expect(
      taskResponsePublicationKind(
        message("agent-message:v\udfff:t\ud800:v\udfff:item"),
        publication,
        native,
        native,
      ),
    ).toBe("native-root");
    expect(
      taskResponsePublicationKind(
        message("agent-message:v\ufffd:t\ufffd:v\ufffd:item"),
        publication,
        native,
        native,
      ),
    ).toBeNull();
  });
  it("retains the exact assigned publisher without requiring new worker metadata", () => {
    expect(
      taskResponsePublicationKind(
        message(publication.idempotencyKey, publication.id),
        publication,
        { threadId: "legacy" },
      ),
    ).toBe("assigned");
    expect(
      taskResponsePublicationKind(
        message(publication.idempotencyKey),
        publication,
        execution,
        execution,
      ),
    ).toBeNull();
  });
  it.each([
    "agent-message:turn:thread:turn:item",
    "agent-message:root:turn:item",
  ])("accepts an exact physical root output %s", (key) => {
    expect(
      taskResponsePublicationKind(
        message(key),
        publication,
        execution,
        execution,
      ),
    ).toBe("native-root");
    expect(
      taskResponsePublicationKind(message(key), publication, execution),
    ).toBeNull();
    expect(
      taskResponsePublicationKind(
        message(key),
        publication,
        { threadId: "other", turnId: "turn" },
        execution,
      ),
    ).toBeNull();
    expect(
      taskResponsePublicationKind(
        message(key),
        publication,
        { threadId: "thread" },
        execution,
      ),
    ).toBeNull();
  });
  it.each([
    "agent-message:turn:child:turn:item",
    "agent-message:old:thread:turn:item",
    "agent-message:turn:thread:old:item",
    "agent-message:root:old:item",
    "agent-message:turn:thread:turn:",
    "agent-message:root:turn:",
    "assistant:unrelated",
  ])("rejects unrelated, child, stale or missing native items %s", (key) => {
    expect(
      taskResponsePublicationKind(
        message(key),
        publication,
        execution,
        execution,
      ),
    ).toBeNull();
  });
});

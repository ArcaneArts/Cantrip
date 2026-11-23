import { expect, it } from "vitest";
import type { ExplorerLogTail } from "@cantrip/protocol/surface-stream";
import { LogTailDocument } from "./log-tail-document";
function result(content: string, offset = 0, reset = true): ExplorerLogTail {
  const end = offset + new TextEncoder().encode(content).length;
  return {
    path: "daemon.log",
    content,
    startOffset: offset,
    size: end,
    reset,
    cursor: { offset: end, identity: "a".repeat(64), anchor: "b".repeat(64) },
  };
}
it("appends output without creating a dirty editable draft or rebuilding unchanged text", () => {
  const log = new LogTailDocument("daemon.log");
  expect(log.accept(result("\ufefffirst\r"))).toBe(true);
  const session = log.session;
  const offset = log.cursor!.offset;
  log.accept(result("\nsecond 😀\r\n", offset, false));
  expect(log.session).toBe(session);
  expect(session.text).toBe("first\nsecond 😀\n");
  expect(session.dirty).toBe(false);
  const revision = session.revision;
  expect(log.accept(result("", log.cursor!.offset, false))).toBe(false);
  expect(session.revision).toBe(revision);
});
it("retains at most 10,000 recent lines and a bounded text buffer", () => {
  const log = new LogTailDocument("daemon.log");
  log.accept(result("old\n".repeat(20_000) + "latest\n"));
  expect(log.session.text.split("\n")).toHaveLength(10_001);
  expect(log.session.text.endsWith("latest\n")).toBe(true);
  log.accept(result("x".repeat(400_000)));
  expect(log.session.text.length).toBeLessThanOrEqual(256 * 1024);
});
it("replaces rotated contents and rejects stale or unrelated append results", () => {
  const log = new LogTailDocument("daemon.log");
  log.accept(result("old\n"));
  expect(() =>
    log.accept({ ...result("bad", 0, false), path: "another.log" }),
  ).toThrow("unrelated");
  expect(() => log.accept(result("bad", 0, false))).toThrow("unrelated");
  expect(log.session.text).toBe("old\n");
  log.accept(result("new\n"));
  expect(log.session.text).toBe("new\n");
});

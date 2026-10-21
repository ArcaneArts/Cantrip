import { describe, expect, it } from "vitest";
import { workerNotificationSchema } from "./worker-events.js";
const notification = {
  type: "worktree.filesystem.changed",
  sourcePath: "/repo",
  worktreePath: "/repo",
};
describe("filesystem change observations", () => {
  it("accepts legacy worktree-only invalidations", () => {
    expect(workerNotificationSchema.parse(notification)).toEqual(notification);
  });
  it.each(["added", "modified", "deleted"])(
    "accepts %s file activity",
    (kind) => {
      const input = {
        ...notification,
        changes: [{ path: "src/file name.ts", kind }],
      };
      expect(workerNotificationSchema.parse(input)).toEqual(input);
    },
  );
  it("rejects invalid or unbounded batches", () => {
    expect(
      workerNotificationSchema.safeParse({
        ...notification,
        changes: [{ path: "src/a", kind: "unknown" }],
      }).success,
    ).toBe(false);
    expect(
      workerNotificationSchema.safeParse({
        ...notification,
        changes: Array.from({ length: 2001 }, () => ({
          path: "src/a",
          kind: "modified",
        })),
      }).success,
    ).toBe(false);
  });
});

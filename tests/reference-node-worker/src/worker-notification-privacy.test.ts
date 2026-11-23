import { describe, expect, it } from "vitest";
import { serverWorkerNotification } from "./worker-notification-privacy.js";
import { workerNotificationSchema } from "@cantrip/protocol";

describe("filesystem observation privacy", () => {
  it("retains file details for the encrypted stream and strips them from server notifications", () => {
    const notification = workerNotificationSchema.parse({
      type: "worktree.filesystem.changed",
      sourcePath: "/repo",
      worktreePath: "/repo",
      changes: [{ path: "private-name.ts", kind: "modified" }],
    });
    const server = serverWorkerNotification(notification);
    expect(server).toEqual({
      type: "worktree.filesystem.changed",
      sourcePath: "/repo",
      worktreePath: "/repo",
    });
    expect(JSON.stringify(notification)).toContain("private-name.ts");
    expect(JSON.stringify(server)).not.toContain("private-name.ts");
    expect(workerNotificationSchema.parse(server)).toEqual(server);
  });
});

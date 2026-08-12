import {
  PROJECT_SHARE_ADAPTER_MAX_HEAD_BYTES,
  projectShareAdapterRequestHeadSchema,
  projectShareAdapterResponseHeadSchema,
  projectShareAttachmentSchema,
  tunnelDataPlaneTargetSchema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("project share tunnel protocol", () => {
  it("models WebDAV adaptation over generic tunnel streams", () => {
    expect(
      tunnelDataPlaneTargetSchema.parse({
        kind: "adapter",
        adapter: "project-share",
        resourceId: "share-1",
      }),
    ).toEqual({
      kind: "adapter",
      adapter: "project-share",
      resourceId: "share-1",
    });
    expect(
      projectShareAdapterRequestHeadSchema.parse({
        protocolVersion: 1,
        method: "PROPFIND",
        path: "/project-shares/public-token/folder?view=all",
        headers: [
          ["Authorization", "Digest username=cantrip"],
          ["Depth", "1"],
        ],
      }),
    ).toMatchObject({ method: "PROPFIND" });
    expect(
      projectShareAdapterResponseHeadSchema.parse({
        protocolVersion: 1,
        statusCode: 207,
        headers: [["DAV", "1, 2"]],
      }),
    ).toMatchObject({ statusCode: 207 });
    expect(PROJECT_SHARE_ADAPTER_MAX_HEAD_BYTES).toBe(64 * 1024);
  });

  it("validates public attachment credentials and mount leases", () => {
    const attachment = {
      attachmentId: "share-1",
      projectId: "project-1",
      protocol: "webdav",
      url: "https://surface.cantrip.example/project-shares/token/",
      username: "cantrip-user",
      password: "a-strong-random-password-value",
      realm: "Cantrip Project Share",
      expiresAt: "2026-08-10T00:00:00.000Z",
      mountLeaseMs: 12 * 60 * 60_000,
    };
    expect(projectShareAttachmentSchema.parse(attachment)).toMatchObject({
      protocol: "webdav",
      projectId: "project-1",
    });
    expect(() =>
      projectShareAttachmentSchema.parse({
        ...attachment,
        mountLeaseMs: 24 * 60 * 60_000 + 1,
      }),
    ).toThrow();
  });
});

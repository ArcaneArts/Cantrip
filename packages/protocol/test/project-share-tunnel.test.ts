import {
  decodeProjectShareTunnelFrame,
  encodeProjectShareTunnelFrame,
  isCodeTunnelFrame,
  isProjectShareTunnelFrame,
  PROJECT_SHARE_TUNNEL_MAX_PAYLOAD_BYTES,
  projectShareAttachmentSchema,
  projectShareTunnelFrameHeaderSchema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("project share tunnel protocol", () => {
  it("round-trips WebDAV request frames on a distinct binary channel", () => {
    const header = projectShareTunnelFrameHeaderSchema.parse({
      protocolVersion: 1,
      shareId: "share-1",
      streamId: "stream-1",
      kind: "http-request-start",
      method: "PROPFIND",
      path: "/project-shares/public-token/folder?view=all",
      headers: [
        ["Authorization", "Digest username=cantrip"],
        ["Depth", "1"],
      ],
    });
    const payload = new TextEncoder().encode("request-body");
    const encoded = encodeProjectShareTunnelFrame(header, payload);

    expect(isProjectShareTunnelFrame(encoded)).toBe(true);
    expect(isCodeTunnelFrame(encoded)).toBe(false);
    const decoded = decodeProjectShareTunnelFrame(encoded);
    expect(decoded.header).toEqual(header);
    expect(new TextDecoder().decode(decoded.payload)).toBe("request-body");
  });

  it("bounds frames and validates public attachment credentials", () => {
    expect(() =>
      encodeProjectShareTunnelFrame(
        {
          protocolVersion: 1,
          shareId: "share-1",
          streamId: "stream-1",
          kind: "http-request-data",
        },
        new Uint8Array(PROJECT_SHARE_TUNNEL_MAX_PAYLOAD_BYTES + 1),
      ),
    ).toThrow("payload exceeds the protocol limit");
    expect(
      projectShareAttachmentSchema.parse({
        attachmentId: "share-1",
        projectId: "project-1",
        protocol: "webdav",
        url: "https://surface.cantrip.example/project-shares/token/",
        username: "cantrip-user",
        password: "a-strong-random-password-value",
        realm: "Cantrip Project Share",
        expiresAt: "2026-08-10T00:00:00.000Z",
        mountLeaseMs: 12 * 60 * 60_000,
      }),
    ).toMatchObject({ protocol: "webdav", projectId: "project-1" });
    expect(() =>
      projectShareAttachmentSchema.parse({
        attachmentId: "share-1",
        projectId: "project-1",
        protocol: "webdav",
        url: "https://surface.cantrip.example/project-shares/token/",
        username: "cantrip-user",
        password: "a-strong-random-password-value",
        realm: "Cantrip Project Share",
        expiresAt: "2026-08-10T00:00:00.000Z",
        mountLeaseMs: 24 * 60 * 60_000 + 1,
      }),
    ).toThrow();
  });
});

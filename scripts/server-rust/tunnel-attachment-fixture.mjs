import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HttpFixture } from "./http-fixture.mjs";
import { tunnelExpiry, secretExpiry } from "./tunnel-state.mjs";
export class AttachmentFixture extends HttpFixture {
  normalize(value, key = "") {
    if (typeof value === "string") {
      if (value.startsWith("worker-link-client:"))
        return (
          "worker-link-client:" +
          super.normalize(value.slice("worker-link-client:".length))
        );
      if (key === "token") {
        assert.match(value, /^[A-Za-z0-9_-]{43}$/);
        this.linkTokens ??= new Map();
        if (!this.linkTokens.has(value))
          this.linkTokens.set(value, `<link-token:${this.linkTokens.size}>`);
        return this.linkTokens.get(value);
      }
      if (value === tunnelExpiry || value === secretExpiry) return value;
      if (
        ["expiresAt", "leaseExpiresAt", "absoluteExpiresAt"].includes(key) &&
        Date.parse(value) > Date.now() + 11 * 3600000
      ) {
        assert.ok(
          Date.parse(value) <= Date.now() + 12 * 3600000 + 1000,
          "actual twelve-hour attachment bound",
        );
        return "<attachment-expiry>";
      }
      if (key === "secretExpiresAt" && value !== secretExpiry) {
        assert.ok(
          Date.parse(value) > Date.now() &&
            Date.parse(value) <= Date.now() + 121000,
          "actual two-minute credential bound",
        );
        return "<attachment-secret-expiry>";
      }
      if (key === "secret") {
        assert.match(value, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(Buffer.from(value, "base64url").length, 32);
        this.attachmentSecrets ??= new Map();
        if (!this.attachmentSecrets.has(value))
          this.attachmentSecrets.set(
            value,
            `<attachment-secret:${this.attachmentSecrets.size}>`,
          );
        this.attachmentHashes ??= new Map();
        this.attachmentHashes.set(
          createHash("sha256").update(value).digest("hex"),
          this.attachmentSecrets.get(value) + ":sha256",
        );
        return this.attachmentSecrets.get(value);
      }
      if (this.attachmentHashes?.has(value))
        return this.attachmentHashes.get(value);
      if (key === "connectPath")
        return (
          "/api/tunnel-attachments/" +
          super.normalize(value.split("/")[3]) +
          "/connect"
        );
      if (key === "sourceEndpointId" && value.startsWith("desktop:"))
        return value.slice(0, -36) + super.normalize(value.slice(-36));
      if (key === "protocol" && value.startsWith("cantrip-tunnel-v1."))
        return (
          "cantrip-tunnel-v1." +
          this.normalize(value.slice("cantrip-tunnel-v1.".length), "secret")
        );
    }
    return super.normalize(value, key);
  }
}

// Real HTTP authentication, validation and response parity for Alert Inbox reads.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { HttpFixture } from "./http-fixture.mjs";
import { buildRustServer } from "./build.mjs";
import { password } from "./security-fixtures.mjs";

const root = await mkdtemp(path.join(tmpdir(), "cantrip-alert-http-"));
const executable =
  process.env.CANTRIP_TEST_SERVER_EXECUTABLE ?? (await buildRustServer());
const passwordHash = await hashPassword(password);
try {
  for (const profile of ["none", "password", "accounts"]) {
    const results = [];
    for (const kind of ["node", "rust"]) {
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode: "pglite",
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          CANTRIP_PASSWORD_HASH: passwordHash,
        },
      });
      const observations = [];
      const visit = async (label, url, status = 200) =>
        observations.push(await fixture.observe(label, "GET", url, { status }));
      try {
        await fixture.start();
        if (profile !== "none") {
          await visit(
            "unauthenticated counts",
            "/api/project-alerts/counts",
            401,
          );
          await visit(
            "unauthenticated Goal source",
            "/api/projects/missing/alerts/missing/goal",
            401,
          );
          await visit(
            "unauthenticated inbox",
            "/api/projects/missing/alerts",
            401,
          );
          await fixture.observe(
            "sign in",
            "POST",
            profile === "accounts" ? "/api/auth/register" : "/api/auth/login",
            {
              status: profile === "accounts" ? 201 : 200,
              json:
                profile === "accounts"
                  ? {
                      email: "alerts@example.invalid",
                      displayName: "Alerts fixture",
                      password,
                    }
                  : { password },
            },
          );
        }
        await visit(
          "unknown Goal source",
          "/api/projects/missing/alerts/missing/goal",
          404,
        );
        await visit("counts", "/api/project-alerts/counts");
        await visit("unknown project", "/api/projects/missing/alerts", 404);
        await visit("zero limit", "/api/projects/missing/alerts?limit=0", 400);
        await visit(
          "oversized limit",
          "/api/projects/missing/alerts?limit=101",
          400,
        );
        await visit(
          "invalid cursor",
          "/api/projects/missing/alerts?after=invalid",
          400,
        );
        await visit(
          "unknown query",
          "/api/projects/missing/alerts?extra=1",
          400,
        );
        await visit(
          "duplicate limit",
          "/api/projects/missing/alerts?limit=1&limit=2",
          400,
        );
        await visit(
          "duplicate cursor",
          `/api/projects/missing/alerts?after=alert_${"a".repeat(64)}&after=alert_${"b".repeat(64)}`,
          400,
        );
        results.push(observations);
      } finally {
        await fixture.close();
      }
    }
    assert.deepEqual(
      results[1],
      results[0],
      `${profile}: Node/Rust HTTP parity`,
    );
    console.log(`${profile}: Alert Inbox HTTP parity passed`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

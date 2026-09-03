import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectTestFlightFeedback,
  createAppStoreConnectToken,
  extractFeedbackMarkers,
  normalizeFeedbackResource,
  renderIssueDraft,
  selectUnimportedFeedback,
} from "./testflight-feedback.mjs";

function decodeJson(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function fixture(kind, id, createdDate) {
  return {
    assets: [],
    attributes: { comment: `Report ${id}`, createdDate },
    build: { version: "42" },
    id,
    kind,
    marker: `<!-- testflight-feedback-id: ${kind}:${id} -->`,
  };
}

test("creates a verifiable App Store Connect token", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const now = Date.parse("2026-09-03T12:00:00Z");
  const token = createAppStoreConnectToken({
    issuerId: "issuer-id",
    keyId: "KEY123",
    now,
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }),
  });
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(decodeJson(header), {
    alg: "ES256",
    kid: "KEY123",
    typ: "JWT",
  });
  const claims = decodeJson(payload);
  assert.equal(claims.iss, "issuer-id");
  assert.equal(claims.aud, "appstoreconnect-v1");
  assert.equal(claims.iat, Math.floor(now / 1_000) - 30);
  assert.equal(claims.exp - claims.iat, 20 * 60);
  assert.equal(
    verify(
      "SHA256",
      Buffer.from(`${header}.${payload}`),
      { dsaEncoding: "ieee-p1363", key: publicKey },
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
});

test("normalization allowlists diagnostic fields and excludes tester identity", () => {
  const normalized = normalizeFeedbackResource(
    {
      attributes: {
        comment: "The button disappeared",
        createdDate: "2026-09-03T10:00:00Z",
        email: "private@example.test",
        testerEmail: "also-private@example.test",
      },
      id: "feedback-1",
      relationships: { build: { data: { id: "build-1" } } },
      type: "betaFeedbackScreenshotSubmissions",
    },
    "screenshot",
    new Map([["build-1", { id: "build-1", version: "42" }]]),
  );
  assert.deepEqual(normalized.attributes, {
    comment: "The button disappeared",
    createdDate: "2026-09-03T10:00:00Z",
  });
  assert.deepEqual(normalized.build, { id: "build-1", version: "42" });
  assert.equal(
    JSON.stringify(normalized).includes("private@example.test"),
    false,
  );
});

test("issue markers deduplicate open and closed issues in four-report batches", () => {
  const feedback = [
    fixture("screenshot", "one", "2026-09-03T01:00:00Z"),
    fixture("screenshot", "two", "2026-09-03T02:00:00Z"),
    fixture("crash", "three", "2026-09-03T03:00:00Z"),
    fixture("screenshot", "four", "2026-09-03T04:00:00Z"),
    fixture("crash", "five", "2026-09-03T05:00:00Z"),
    fixture("screenshot", "six", "2026-09-03T06:00:00Z"),
  ];
  const existingBodies = [
    "A closed issue\n<!-- testflight-feedback-id: screenshot:two -->",
    "An open issue\n<!-- testflight-feedback-id: crash:five -->",
  ];
  assert.deepEqual(
    [...extractFeedbackMarkers(existingBodies)],
    ["screenshot:two", "crash:five"],
  );
  assert.deepEqual(
    selectUnimportedFeedback(feedback, existingBodies).map(
      ({ kind, id }) => `${kind}:${id}`,
    ),
    ["screenshot:one", "crash:three", "screenshot:four", "screenshot:six"],
  );
  assert.throws(
    () => selectUnimportedFeedback(feedback, existingBodies, 5),
    /1-4 reports/u,
  );
});

test("public issue drafts embed screenshots but not crash logs or identity", () => {
  const feedback = {
    ...fixture("screenshot", "feedback-1", "2026-09-03T10:00:00Z"),
    assets: [
      { kind: "screenshot", path: "screenshot/feedback-1/screen one.png" },
      { kind: "crash-log", path: "crash/feedback-1/crash.log" },
    ],
    attributes: {
      comment: "The button disappeared\nafter tapping Share.",
      createdDate: "2026-09-03T10:00:00Z",
      deviceModel: "iPhone17,1",
      osVersion: "26.0",
    },
  };
  const draft = renderIssueDraft(feedback, {
    assetBaseUrl: "https://github.example/assets",
  });
  assert.match(draft.title, /^\[TestFlight\] The button disappeared/u);
  assert.match(draft.body, /screenshot\/feedback-1\/screen%20one\.png/u);
  assert.doesNotMatch(draft.body, /crash\.log/u);
  assert.match(
    draft.body,
    /Tester identity and email were intentionally omitted/u,
  );
  assert.match(draft.body, /testflight-feedback-id: screenshot:feedback-1/u);
});

test("collector downloads screenshots and private crash logs", async () => {
  const outputDirectory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-testflight-feedback-"),
  );
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const credentials = {
    issuerId: "issuer-id",
    keyId: "KEY123",
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }),
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    const target = new URL(url);
    calls.push({
      authorization: options?.headers?.Authorization ?? null,
      pathname: target.pathname,
    });
    if (target.hostname === "feedback.example.test") {
      return new Response(Buffer.from("image bytes"), {
        headers: { "content-type": "image/png" },
      });
    }
    if (target.pathname === "/v1/apps") {
      return Response.json({
        data: [
          {
            attributes: { bundleId: "art.cantrip", name: "Cantrip" },
            id: "app-1",
            type: "apps",
          },
        ],
      });
    }
    if (
      target.pathname === "/v1/apps/app-1/betaFeedbackScreenshotSubmissions"
    ) {
      if (target.searchParams.get("cursor") === "next") {
        return Response.json({
          data: [
            {
              attributes: {
                comment: "Second screenshot report",
                createdDate: "2026-09-03T10:30:00Z",
                screenshots: [],
              },
              id: "screenshot-2",
              type: "betaFeedbackScreenshotSubmissions",
            },
          ],
        });
      }
      return Response.json({
        data: [
          {
            attributes: {
              comment: "Screenshot report",
              createdDate: "2026-09-03T10:00:00Z",
              email: "private@example.test",
              screenshots: [
                {
                  height: 200,
                  url: "https://feedback.example.test/screenshot.png",
                  width: 100,
                },
              ],
            },
            id: "screenshot-1",
            relationships: { build: { data: { id: "build-1" } } },
            type: "betaFeedbackScreenshotSubmissions",
          },
        ],
        included: [
          {
            attributes: { version: "42" },
            id: "build-1",
            type: "builds",
          },
        ],
        links: {
          next: "https://api.appstoreconnect.apple.com/v1/apps/app-1/betaFeedbackScreenshotSubmissions?cursor=next",
        },
      });
    }
    if (target.pathname === "/v1/apps/app-1/betaFeedbackCrashSubmissions") {
      return Response.json({
        data: [
          {
            attributes: {
              comment: "Crash report",
              createdDate: "2026-09-03T11:00:00Z",
            },
            id: "crash-1",
            type: "betaFeedbackCrashSubmissions",
          },
        ],
      });
    }
    if (
      target.pathname === "/v1/betaFeedbackCrashSubmissions/crash-1/crashLog"
    ) {
      return Response.json({
        data: { attributes: { logText: "private crash log" } },
      });
    }
    return new Response("not found", { status: 404 });
  };

  const manifest = await collectTestFlightFeedback({
    credentials,
    fetchImpl,
    now: new Date("2026-09-03T12:00:00Z"),
    outputDirectory,
  });

  assert.deepEqual(
    manifest.feedback.map(({ id }) => id),
    ["screenshot-1", "screenshot-2", "crash-1"],
  );
  assert.equal(
    JSON.stringify(manifest).includes("private@example.test"),
    false,
  );
  assert.equal(
    await readFile(
      path.join(outputDirectory, "screenshot/screenshot-1/screenshot-1.png"),
      "utf8",
    ),
    "image bytes",
  );
  assert.equal(
    await readFile(outputDirectory + "/crash/crash-1/crash.log", "utf8"),
    "private crash log",
  );
  assert.equal(
    calls
      .filter(({ pathname }) => pathname.startsWith("/v1/"))
      .every(({ authorization }) => authorization?.startsWith("Bearer ")),
    true,
  );
  assert.equal(
    calls.find(({ pathname }) => pathname === "/screenshot.png")?.authorization,
    null,
  );
});

test("workflow uploads only a short-lived encrypted artifact", async () => {
  const workflow = await readFile(
    new URL(
      "../.github/workflows/testflight-feedback-collect.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /permissions:\n  contents: read/u);
  assert.match(workflow, /openssl cms -encrypt/u);
  assert.match(
    workflow,
    /path: \$\{\{ runner\.temp \}\}\/testflight-feedback\.cms/u,
  );
  assert.match(workflow, /retention-days: 1/u);
  assert.doesNotMatch(workflow, /upload-artifact[\s\S]*manifest\.json/u);
  assert.doesNotMatch(
    workflow,
    /upload-artifact[\s\S]*path:.*testflight-feedback\.tar\.gz/u,
  );
});

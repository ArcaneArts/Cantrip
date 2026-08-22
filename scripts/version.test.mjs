import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  repositoryRoot,
  renderVersionModule,
  resolveCantripVersion,
} from "./version.mjs";

test("builds the official version from version.json and Git commit count", () => {
  assert.deepEqual(
    resolveCantripVersion({
      environment: {},
      loadVersionConfig: () => ({ major: 1, minor: 1 }),
      loadGitCommitCount: () => "1375",
    }),
    {
      major: 1,
      minor: 1,
      patch: 1375,
      version: "1.1.1375",
      synthetic: false,
      commitSha: null,
      builtAt: null,
      buildId: null,
      overlayDigest: null,
    },
  );
});

test("accepts an explicit patch when Git metadata is outside the build context", () => {
  assert.deepEqual(
    resolveCantripVersion({
      environment: { CANTRIP_VERSION_PATCH: "1375" },
      loadVersionConfig: () => ({ major: 1, minor: 1 }),
      loadGitCommitCount: () => {
        throw new Error("Git should not be read when the patch is explicit.");
      },
    }),
    {
      major: 1,
      minor: 1,
      patch: 1375,
      version: "1.1.1375",
      synthetic: false,
      commitSha: null,
      builtAt: null,
      buildId: null,
      overlayDigest: null,
    },
  );
  assert.throws(
    () =>
      resolveCantripVersion({
        environment: { CANTRIP_VERSION_PATCH: "not-a-count" },
        loadVersionConfig: () => ({ major: 1, minor: 1 }),
      }),
    /CANTRIP_VERSION_PATCH must be a non-negative integer/u,
  );
});

test("builds a synthetic version with immutable build identity", () => {
  assert.deepEqual(
    resolveCantripVersion({
      environment: {
        CANTRIP_VERSION_PATCH: "1375",
        CANTRIP_SYNTHETIC_BUILD: "1",
        CANTRIP_SYNTHETIC_COMMIT_SHA:
          "0123456789abcdef0123456789abcdef01234567",
        CANTRIP_SYNTHETIC_BUILT_AT: "2026-08-22T18:00:00-05:00",
        CANTRIP_SYNTHETIC_BUILD_ID: "synthetic-1375",
        CANTRIP_SYNTHETIC_OVERLAY_DIGEST:
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      },
      loadVersionConfig: () => ({ major: 1, minor: 1 }),
    }),
    {
      major: 1,
      minor: 1,
      patch: 1375,
      version: "1.1.1375-x",
      synthetic: true,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      builtAt: "2026-08-22T23:00:00.000Z",
      buildId: "synthetic-1375",
      overlayDigest:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    },
  );
});

test("rejects incomplete or malformed synthetic identity", () => {
  const baseEnvironment = {
    CANTRIP_VERSION_PATCH: "1375",
    CANTRIP_SYNTHETIC_BUILD: "1",
    CANTRIP_SYNTHETIC_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    CANTRIP_SYNTHETIC_BUILT_AT: "2026-08-22T23:00:00.000Z",
    CANTRIP_SYNTHETIC_BUILD_ID: "synthetic-1375",
    CANTRIP_SYNTHETIC_OVERLAY_DIGEST:
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  };
  for (const name of [
    "CANTRIP_SYNTHETIC_COMMIT_SHA",
    "CANTRIP_SYNTHETIC_BUILT_AT",
    "CANTRIP_SYNTHETIC_BUILD_ID",
    "CANTRIP_SYNTHETIC_OVERLAY_DIGEST",
  ]) {
    const environment = { ...baseEnvironment };
    delete environment[name];
    assert.throws(() =>
      resolveCantripVersion({
        environment,
        loadVersionConfig: () => ({ major: 1, minor: 1 }),
      }),
    );
  }
});

test("rejects patch fields and invalid version components", () => {
  assert.throws(
    () =>
      resolveCantripVersion({
        environment: {},
        loadVersionConfig: () => ({ major: 1, minor: 1, patch: 2 }),
        loadGitCommitCount: () => "10",
      }),
    /only major and minor/,
  );
  assert.throws(
    () =>
      resolveCantripVersion({
        environment: {},
        loadVersionConfig: () => ({ major: 1, minor: -1 }),
        loadGitCommitCount: () => "10",
      }),
    /non-negative safe integer/,
  );
});

test("the root version file contains only the human-controlled components", async () => {
  const versionConfig = JSON.parse(
    await readFile(path.join(repositoryRoot, "version.json"), "utf8"),
  );
  assert.deepEqual(versionConfig, { major: 1, minor: 1 });
});

test("renders an immutable runtime module", () => {
  const source = renderVersionModule({
    major: 1,
    minor: 1,
    patch: 1375,
    version: "1.1.1375",
    synthetic: false,
    commitSha: null,
    builtAt: null,
    buildId: null,
    overlayDigest: null,
  });
  assert.match(source, /CANTRIP_VERSION = "1\.1\.1375"/u);
  assert.match(source, /Object\.freeze/u);
});

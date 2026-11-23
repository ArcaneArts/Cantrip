import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureLegacyProviderCredential,
  discardLegacyProviderCredential,
  legacyProviderCredentialSubject,
} from "../src/legacy-provider-credentials.js";

const directories: string[] = [];

async function credentialHome(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-legacy-provider-auth-"),
  );
  directories.push(directory);
  return directory;
}

function jwt(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("legacy provider credentials", () => {
  it("captures ChatGPT auth.json before the protected upload discards it", async () => {
    const home = await credentialHome();
    const accessToken = jwt({ exp: 1_800_000_000 });
    const idToken = jwt({
      email: "person@example.test",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "upstream-account",
        chatgpt_plan_type: "pro",
        chatgpt_user_id: "upstream-user",
      },
    });
    await writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          account_id: "upstream-account",
          id_token: idToken,
          refresh_token: "chatgpt-refresh-token",
        },
      }),
    );

    const captured = await captureLegacyProviderCredential(home, "chatgpt");
    expect(captured).toMatchObject({
      status: "available",
      credential: {
        accessToken,
        accountId: "upstream-account",
        email: "person@example.test",
        expiresAt: 1_800_000_000_000,
        idToken,
        kind: "chatgpt",
        planType: "pro",
        refreshToken: "chatgpt-refresh-token",
        userId: "upstream-user",
      },
    });
    if (captured.status !== "available") throw new Error("capture failed");
    expect(legacyProviderCredentialSubject(captured.credential)).toBe(
      "chatgpt:upstream-account",
    );
    await expect(
      discardLegacyProviderCredential(home, "chatgpt"),
    ).resolves.toBe(true);
    expect(
      (await captureLegacyProviderCredential(home, "chatgpt")).status,
    ).toBe("missing");
  });

  it("captures and discards Grok credentials without provider logout", async () => {
    const home = await credentialHome();
    await writeFile(
      path.join(home, "grok-auth.json"),
      JSON.stringify({
        accessToken: "grok-access-token",
        email: "grok@example.test",
        expiresAt: 1_800_000_000_000,
        planType: "SuperGrok",
        refreshToken: "grok-refresh-token",
        userId: "grok-user",
        version: 1,
      }),
    );

    const captured = await captureLegacyProviderCredential(home, "grok");
    expect(captured).toMatchObject({
      status: "available",
      credential: {
        accessToken: "grok-access-token",
        kind: "grok",
        refreshToken: "grok-refresh-token",
        userId: "grok-user",
      },
    });
    await expect(discardLegacyProviderCredential(home, "grok")).resolves.toBe(
      true,
    );
  });

  it("reports malformed files without echoing their contents", async () => {
    const home = await credentialHome();
    const leakedCandidate = "refresh-token-that-must-not-escape";
    await writeFile(
      path.join(home, "grok-auth.json"),
      JSON.stringify({ refreshToken: leakedCandidate, version: 999 }),
    );

    const captured = await captureLegacyProviderCredential(home, "grok");
    expect(captured).toEqual({ status: "malformed" });
    expect(JSON.stringify(captured)).not.toContain(leakedCandidate);
    await expect(discardLegacyProviderCredential(home, "grok")).resolves.toBe(
      true,
    );
    expect((await captureLegacyProviderCredential(home, "grok")).status).toBe(
      "missing",
    );
  });
});

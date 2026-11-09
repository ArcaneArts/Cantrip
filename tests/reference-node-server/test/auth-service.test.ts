import { describe, expect, it } from "vitest";

import {
  AuthRateLimiter,
  hashPassword,
  normalizeAccountEmail,
  verifyPassword,
} from "../src/auth/service.js";

describe("authentication primitives", () => {
  it("uses Argon2id encoded password hashes", async () => {
    const passwordHash = await hashPassword("a long and unique password");
    expect(passwordHash).toMatch(/^\$argon2id\$/u);
    await expect(
      verifyPassword(passwordHash, "a long and unique password"),
    ).resolves.toBe(true);
    await expect(verifyPassword(passwordHash, "wrong password")).resolves.toBe(
      false,
    );
  });

  it("normalizes account email identity without changing the display email", () => {
    expect(normalizeAccountEmail("  OWNER@Example.COM ")).toBe(
      "owner@example.com",
    );
  });

  it("rate limits repeated authentication attempts within a window", () => {
    const limiter = new AuthRateLimiter(2, 1_000);
    expect(limiter.consume("login:client", 1_000)).toBeNull();
    expect(limiter.consume("login:client", 1_100)).toBeNull();
    expect(limiter.consume("login:client", 1_200)).toBe(1);
    expect(limiter.consume("login:client", 2_101)).toBeNull();
  });
});

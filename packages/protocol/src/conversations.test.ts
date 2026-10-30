import { describe, expect, it } from "vitest";
import {
  conversationCatalogQuerySchema,
  conversationCursorSchema,
  conversationRestoreSchema,
  conversationUsageSchema,
} from "./conversations.js";

describe("conversation catalog contracts", () => {
  it("bounds pages and rejects ambiguous query fields", () => {
    expect(conversationCatalogQuerySchema.parse({})).toEqual({
      state: "active",
      limit: 50,
    });
    expect(
      conversationCatalogQuerySchema.parse({ state: "archived", limit: "100" })
        .limit,
    ).toBe(100);
    for (const input of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { state: "task" },
      { cursor: "" },
      { cursor: "x".repeat(2049) },
      { ownerId: "another-owner" },
    ]) {
      expect(conversationCatalogQuerySchema.safeParse(input).success).toBe(
        false,
      );
    }
  });

  it("requires stable usage identities and a safe positive sequence", () => {
    const input = {
      clientId: "11111111-1111-4111-8111-111111111111",
      operationId: "22222222-2222-4222-8222-222222222222",
      sequence: 1,
    };
    expect(conversationUsageSchema.parse(input)).toEqual(input);
    for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        conversationUsageSchema.safeParse({ ...input, sequence }).success,
      ).toBe(false);
    }
    expect(
      conversationUsageSchema.safeParse({
        ...input,
        lastUsedAt: "2026-10-30T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      conversationUsageSchema.safeParse({ ...input, operationId: "" }).success,
    ).toBe(false);
  });

  it("preserves precise cursor timestamps and explicit resource-only restore", () => {
    const cursor = {
      version: 1,
      projectId: "project",
      state: "archived",
      at: "2026-10-30T00:00:00.123456Z",
      createdAt: "2026-10-29T00:00:00.654321Z",
      id: "chat",
    };
    expect(conversationCursorSchema.parse(cursor)).toEqual(cursor);
    expect(
      conversationCursorSchema.safeParse({ ...cursor, version: 2 }).success,
    ).toBe(false);
    expect(conversationRestoreSchema.parse({})).toEqual({});
    expect(
      conversationRestoreSchema.parse({ attachToTabLayout: false }),
    ).toEqual({ attachToTabLayout: false });
    expect(
      conversationRestoreSchema.safeParse({ attachToTabLayout: "false" })
        .success,
    ).toBe(false);
  });
});

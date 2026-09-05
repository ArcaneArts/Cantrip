import { describe, expect, it, vi } from "vitest";

import { ComputerUseAuthorityChanges } from "../src/db/repository/computer-use-authority.js";
import { serverLogger } from "../src/logger.js";

const notification = (chatId = "chat-a") =>
  JSON.stringify({
    ownerId: "owner-a",
    scope: { kind: "chat", chatId },
  });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("computer-use committed authority publisher", () => {
  it("delivers the narrow scope and stops after unsubscribe", async () => {
    const publisher = new ComputerUseAuthorityChanges();
    const listener = vi.fn();
    const unsubscribe = publisher.subscribe(listener);
    publisher.receive(notification());
    expect(listener).toHaveBeenCalledExactlyOnceWith(
      JSON.parse(notification()),
    );
    expect(Object.isFrozen(listener.mock.calls[0]?.[0])).toBe(true);
    expect(Object.isFrozen(listener.mock.calls[0]?.[0].scope)).toBe(true);
    await flush();
    unsubscribe();
    publisher.receive(notification());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("isolates synchronous and asynchronous observer errors without logging their private text", async () => {
    const warning = vi
      .spyOn(serverLogger, "rateLimited")
      .mockImplementation(() => undefined);
    try {
      const publisher = new ComputerUseAuthorityChanges();
      publisher.subscribe(() => {
        throw new Error("private sync text");
      });
      publisher.subscribe(async () => {
        throw new Error("private async text");
      });
      const healthy = vi.fn();
      publisher.subscribe(healthy);
      expect(() => publisher.receive(notification())).not.toThrow();
      await flush();
      expect(healthy).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private");
    } finally {
      warning.mockRestore();
    }
  });

  it("rejects malformed, oversized and foreign notification content", () => {
    const warning = vi
      .spyOn(serverLogger, "rateLimited")
      .mockImplementation(() => undefined);
    try {
      const publisher = new ComputerUseAuthorityChanges();
      const listener = vi.fn();
      publisher.subscribe(listener);
      for (const payload of [
        "{",
        "x".repeat(4097),
        JSON.stringify({
          ownerId: "owner-a",
          scope: { kind: "chat", chatId: "a", nativeWindow: "secret" },
        }),
        JSON.stringify({ ownerId: "", scope: { kind: "chat", chatId: "a" } }),
      ])
        publisher.receive(payload);
      expect(listener).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledTimes(4);
    } finally {
      warning.mockRestore();
    }
  });

  it("bounds pending worker I/O and coalesces same-scope changes during a delivery", async () => {
    const warning = vi
      .spyOn(serverLogger, "rateLimited")
      .mockImplementation(() => undefined);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const publisher = new ComputerUseAuthorityChanges();
      const listener = vi.fn(() => blocked);
      const unsubscribe = publisher.subscribe(listener);
      for (let i = 0; i < 1000; i += 1)
        publisher.receive(notification(`chat-${i}`));
      for (let i = 0; i < 1000; i += 1)
        publisher.receive(notification("chat-0"));
      expect(listener).toHaveBeenCalledTimes(256);
      release();
      await flush();
      expect(listener).toHaveBeenCalledTimes(257);
      publisher.receive(notification("new-after-drain"));
      await flush();
      expect(listener).toHaveBeenCalledTimes(258);
      expect(warning).toHaveBeenCalled();
      unsubscribe();
    } finally {
      release();
      warning.mockRestore();
    }
  });
});

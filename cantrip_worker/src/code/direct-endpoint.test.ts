import { describe, expect, it, vi } from "vitest";

import {
  CodeDirectEndpointManager,
  forwardableCodeWebSocketClose,
} from "./direct-endpoint.js";
import type { CodeSupervisor } from "./supervisor.js";

describe("forwardableCodeWebSocketClose", () => {
  it.each([1000, 1001, 1011, 3000, 4999])(
    "preserves valid close code %i",
    (code) => {
      const reason = Buffer.from("closed");
      expect(forwardableCodeWebSocketClose(code, reason)).toEqual({
        code,
        reason,
      });
    },
  );

  it.each([0, 1004, 1005, 1006, 1015, 2999, 5000])(
    "replaces non-forwardable close code %i",
    (code) => {
      expect(
        forwardableCodeWebSocketClose(code, Buffer.from("abnormal")),
      ).toEqual({
        code: 1011,
        reason: "Cantrip Code peer disconnected abnormally",
      });
    },
  );
});

describe("CodeDirectEndpointManager file-open control", () => {
  it("reuses the worker-local endpoint for a protected tunnel session", async () => {
    const manager = new CodeDirectEndpointManager({} as CodeSupervisor);
    try {
      const first = await manager.prepareProtected("tunnel-1", "session-1");
      const second = await manager.prepareProtected("tunnel-1", "session-1");
      expect(second).toEqual(first);

      const rotated = await manager.prepareProtected("tunnel-1", "session-2");
      expect(rotated.port).not.toBe(first.port);
    } finally {
      manager.close();
    }
  });

  it("deduplicates concurrent preparation for the same protected tunnel", async () => {
    const manager = new CodeDirectEndpointManager({} as CodeSupervisor);
    try {
      const [first, second] = await Promise.all([
        manager.prepareProtected("tunnel-concurrent", "session-1"),
        manager.prepareProtected("tunnel-concurrent", "session-1"),
      ]);

      expect(second).toEqual(first);
    } finally {
      manager.close();
    }
  });

  it("retires protected endpoints when the server control connection is lost", async () => {
    const manager = new CodeDirectEndpointManager({} as CodeSupervisor);
    try {
      const endpoint = await manager.prepareProtected(
        "tunnel-disconnected",
        "session-1",
      );

      manager.disconnect();

      await expect(
        fetch(`http://${endpoint.host}:${endpoint.port}/code`),
      ).rejects.toThrow();
      const reconnected = await manager.prepareProtected(
        "tunnel-disconnected",
        "session-1",
      );
      expect(reconnected).toMatchObject({ kind: "tcp", host: "127.0.0.1" });
    } finally {
      manager.close();
    }
  });

  it("opens a file in the bound session without server mediation", async () => {
    const openFile = vi
      .fn()
      .mockResolvedValue({ relativePath: "src/index.ts" });
    const manager = new CodeDirectEndpointManager({
      openFile,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected("tunnel-1", "session-1");
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/open-file`,
        {
          body: JSON.stringify({ relativePath: "src/index.ts" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      await expect(response.json()).resolves.toEqual({
        relativePath: "src/index.ts",
      });
      expect(openFile).toHaveBeenCalledWith("session-1", "src/index.ts");
    } finally {
      manager.close();
    }
  });

  it("serializes accepted file opens so a delayed older request cannot win", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let activePath: string | null = null;
    const openFile = vi.fn(async (_sessionId: string, relativePath: string) => {
      if (relativePath === "src/first.ts") await firstGate;
      activePath = relativePath;
      return { relativePath };
    });
    const manager = new CodeDirectEndpointManager({
      openFile,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected("tunnel-1", "session-1");
      const url = `http://${endpoint.host}:${endpoint.port}/code/_cantrip/open-file`;
      const first = fetch(url, {
        body: JSON.stringify({ relativePath: "src/first.ts" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      await vi.waitFor(() => expect(openFile).toHaveBeenCalledTimes(1));
      const second = fetch(url, {
        body: JSON.stringify({ relativePath: "src/second.ts" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(openFile).toHaveBeenCalledTimes(1);

      releaseFirst?.();
      await Promise.all([first, second]);

      expect(openFile.mock.calls.map((call) => call[1])).toEqual([
        "src/first.ts",
        "src/second.ts",
      ]);
      expect(activePath).toBe("src/second.ts");
    } finally {
      manager.close();
    }
  });

  it("drains accepted file opens before a Code session can stop", async () => {
    let finishOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    const openFile = vi.fn(async () => {
      await openGate;
      return { relativePath: "src/pending.ts" };
    });
    const manager = new CodeDirectEndpointManager({
      openFile,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected("tunnel-1", "session-1");
      const request = fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/open-file`,
        {
          body: JSON.stringify({ relativePath: "src/pending.ts" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ).catch(() => undefined);
      await vi.waitFor(() => expect(openFile).toHaveBeenCalledOnce());
      const queuedRequest = fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/open-file`,
        {
          body: JSON.stringify({ relativePath: "src/queued.ts" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 25));
      let stopped = false;
      const stop = manager.closeSession("session-1").then(() => {
        stopped = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(stopped).toBe(false);
      finishOpen?.();
      await Promise.all([request, queuedRequest, stop]);
      expect(stopped).toBe(true);
      expect(openFile).toHaveBeenCalledOnce();
    } finally {
      manager.close();
    }
  });

  it("answers the browser CORS preflight without proxying to Code", async () => {
    const openFile = vi.fn();
    const manager = new CodeDirectEndpointManager({
      openFile,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected("tunnel-2", "session-2");
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/open-file`,
        { method: "OPTIONS" },
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-methods")).toBe(
        "POST, OPTIONS",
      );
      expect(openFile).not.toHaveBeenCalled();
    } finally {
      manager.close();
    }
  });
});

describe("CodeDirectEndpointManager presentation control", () => {
  it("switches the bound compatibility session into editor-only mode", async () => {
    const setPresentation = vi.fn().mockResolvedValue({ status: "running" });
    const manager = new CodeDirectEndpointManager({
      setPresentation,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepareProtected("tunnel-3", "session-3");
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/presentation`,
        {
          body: JSON.stringify({ presentation: "editor" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        presentation: "editor",
      });
      expect(setPresentation).toHaveBeenCalledWith("session-3", "editor");
    } finally {
      manager.close();
    }
  });
});

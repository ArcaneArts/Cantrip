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
  it("opens a file in the bound session without server mediation", async () => {
    const openFile = vi
      .fn()
      .mockResolvedValue({ relativePath: "src/index.ts" });
    const manager = new CodeDirectEndpointManager({
      openFile,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepare("capability-1", "session-1");
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

  it("answers the browser CORS preflight without proxying to Code", async () => {
    const openFile = vi.fn();
    const manager = new CodeDirectEndpointManager({
      openFile,
    } as unknown as CodeSupervisor);

    try {
      const endpoint = await manager.prepare("capability-2", "session-2");
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

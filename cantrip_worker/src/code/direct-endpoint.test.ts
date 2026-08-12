import { describe, expect, it } from "vitest";

import { forwardableCodeWebSocketClose } from "./direct-endpoint.js";

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

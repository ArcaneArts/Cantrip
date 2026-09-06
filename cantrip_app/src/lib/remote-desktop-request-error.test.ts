import { describe, expect, it } from "vitest";

import { CantripApiError } from "./api-client";
import { remoteDesktopRequestError } from "./remote-desktop-request-error";

describe("Remote Desktop request errors", () => {
  it("turns a raw mobile fetch failure into actionable creation guidance", () => {
    const cause = new TypeError("Load failed");

    expect(remoteDesktopRequestError("create", cause)).toMatchObject({
      cause,
      message:
        "Cantrip could not reach the selected server to create Remote Desktop. Check the server connection and try again.",
    });
  });

  it("uses the load action when an existing Remote Desktop cannot be fetched", () => {
    const cause = new TypeError("Failed to fetch");

    expect(remoteDesktopRequestError("load", cause)).toMatchObject({
      cause,
      message:
        "Cantrip could not reach the selected server to load Remote Desktop. Check the server connection and try again.",
    });
  });

  it("explains an unreadable server response without losing its cause", () => {
    const cause = new SyntaxError("Unexpected token");

    expect(remoteDesktopRequestError("load", cause)).toMatchObject({
      cause,
      message:
        "The selected Cantrip Server returned an unreadable response while trying to load Remote Desktop. Try again, then check the server logs if the problem continues.",
    });
  });

  it("preserves structured server errors and their diagnostic context", () => {
    const serverError = new CantripApiError(
      "The selected worker is offline.",
      409,
      "worker-offline",
      {
        failureStage: "worker-selection",
        requestId: "request-one",
        workerId: "worker-one",
      },
    );

    expect(remoteDesktopRequestError("create", serverError)).toBe(serverError);
  });
});

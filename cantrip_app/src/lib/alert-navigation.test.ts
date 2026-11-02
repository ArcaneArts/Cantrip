// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setClientSession, clearClientSession } from "./client-session";
import {
  readAlertNavigation,
  requestAlertNavigation,
  revealAlertDestination,
  type AlertNavigation,
} from "./alert-navigation";
import type { ProjectAlert } from "@cantrip/protocol";
const alert = {
  projectId: "project",
  target: { kind: "interaction", chatId: "chat", requestId: "exact" },
} as ProjectAlert;
beforeEach(() =>
  setClientSession({
    authMode: "accounts",
    csrfToken: null,
    expiresAt: null,
    serverId: "server",
    user: {
      id: "owner",
      kind: "account",
      displayName: "Owner",
      email: "owner@example.invalid",
      role: "member",
    },
  }),
);
afterEach(() => {
  clearClientSession();
  localStorage.clear();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
it("retains an exact temporary destination for the owning window, scoped by account and project", () => {
  requestAlertNavigation(alert, false);
  expect(readAlertNavigation("project")?.target).toEqual(alert.target);
  expect(readAlertNavigation("other")).toBeNull();
  clearClientSession();
  expect(readAlertNavigation("project")).toBeNull();
});
it("reveals the exact request without approving it or touching another request", () => {
  const root = document.createElement("div");
  root.innerHTML =
    '<button data-interaction-request-id="wrong">Approve wrong</button><button data-interaction-request-id="exact">Approve exact</button>';
  document.body.append(root);
  const wanted = root.children[1] as HTMLElement;
  const wrong = root.children[0] as HTMLElement;
  const clicked = vi.fn();
  wanted.addEventListener("click", clicked);
  wrong.addEventListener("click", clicked);
  wanted.scrollIntoView = vi.fn();
  wrong.scrollIntoView = vi.fn();
  vi.spyOn(wanted, "getClientRects").mockReturnValue([{}] as never);
  const navigation = {
    id: crypto.randomUUID(),
    projectId: "project",
    createdAt: Date.now(),
    task: false,
    target: alert.target,
  } as AlertNavigation;
  expect(revealAlertDestination(root, navigation)).toBe(true);
  expect(wanted.scrollIntoView).toHaveBeenCalled();
  expect(wrong.scrollIntoView).not.toHaveBeenCalled();
  expect(clicked).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(wanted);
});
it("does not navigate a hidden or unavailable destination and preserves ordinary opening when storage is unavailable", () => {
  const root = document.createElement("div");
  root.innerHTML =
    '<div aria-hidden="true"><button data-interaction-request-id="exact">Approve</button></div>';
  const wanted = root.querySelector("button")!;
  vi.spyOn(wanted, "getClientRects").mockReturnValue([{}] as never);
  expect(
    revealAlertDestination(root, {
      id: crypto.randomUUID(),
      projectId: "project",
      createdAt: Date.now(),
      task: false,
      target: alert.target,
    } as AlertNavigation),
  ).toBe(false);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  expect(() => requestAlertNavigation(alert, false)).not.toThrow();
  expect(readAlertNavigation("project")?.target).toEqual(alert.target);
});

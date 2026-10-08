// @vitest-environment jsdom
import {
  policyAssignmentListSchema,
  policySummarySchema,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyAssignmentControls } from "./policy-assignment-controls";

const policy = policySummarySchema.parse({
  id: "policy-one",
  key: "fixture-policy",
  name: "Fixture policy",
  summary: "Fixture",
  enabled: true,
  mandatory: false,
  position: 0,
  templateKey: null,
  rowVersion: 1,
  workspaceAssignmentCount: 0,
  projectAssignmentCount: 0,
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
});
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});
async function renderScope(kind: "project" | "workspace") {
  client.setQueryData(
    [`${kind}-policy-assignments`, "scope-one"],
    policyAssignmentListSchema.parse({
      collectionVersion: 1,
      policies: [policy],
      directPolicyIds: [],
    }),
  );
  client.setQueryData(["effective-policies", "scope-one"], { policies: [] });
  client.setQueryData(["project-workspaces"], []);
  // Production passes this optional-ID callback to both Manage and Edit.
  const onOpenPolicySettings = vi.fn<(policyId?: string) => void>();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PolicyAssignmentControls
          scope={{ kind, id: "scope-one", name: "Fixture scope" }}
          onManagePolicies={onOpenPolicySettings}
          onEditPolicy={onOpenPolicySettings}
        />
      </QueryClientProvider>,
    ),
  );
  return onOpenPolicySettings;
}
async function clickButton(name: string) {
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === name,
  );
  expect(button).toBeTruthy();
  // Dispatch a real DOM click so React supplies its event to the bound handler.
  await act(async () => button!.click());
}
describe("policy assignment navigation", () => {
  for (const kind of ["project", "workspace"] as const) {
    it(`${kind} Manage opens root policy settings without an event argument`, async () => {
      const open = await renderScope(kind);
      await clickButton("Manage policy content");
      expect(open).toHaveBeenCalledExactlyOnceWith();
    });
    it(`${kind} Edit preserves the selected policy string ID`, async () => {
      const open = await renderScope(kind);
      await clickButton("Edit Fixture policy in root Settings");
      expect(open).toHaveBeenCalledExactlyOnceWith("policy-one");
    });
  }
});

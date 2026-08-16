import { modelProviderAccountSummarySchema } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ProviderAccountPriorityChips,
  reorderedProviderAccounts,
} from "./provider-account-priority";

const now = "2026-08-16T12:00:00.000Z";
const accounts = [
  modelProviderAccountSummarySchema.parse({
    id: "primary",
    providerId: "provider-one",
    label: "Primary",
    email: null,
    planType: null,
    position: 0,
    enabled: true,
    credentialState: "signed-in",
    workerBindings: [],
    createdAt: now,
    updatedAt: now,
  }),
  modelProviderAccountSummarySchema.parse({
    id: "backup",
    providerId: "provider-one",
    label: "Backup",
    email: null,
    planType: null,
    position: 1,
    enabled: true,
    credentialState: "signed-out",
    workerBindings: [],
    createdAt: now,
    updatedAt: now,
  }),
];

describe("provider account priority", () => {
  it("moves accounts and normalizes their priority positions", () => {
    expect(
      reorderedProviderAccounts(accounts, "backup", "primary").map(
        ({ id, position }) => ({ id, position }),
      ),
    ).toEqual([
      { id: "backup", position: 0 },
      { id: "primary", position: 1 },
    ]);
  });

  it("renders account priority and selected state on sortable chips", () => {
    const markup = renderToStaticMarkup(
      <ProviderAccountPriorityChips
        accounts={accounts}
        disabled={false}
        selectedAccountId="primary"
        onReorder={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(markup).toContain("Primary, priority 1");
    expect(markup).toContain("Backup, priority 2");
    expect(markup).toContain("Drag Primary to change priority");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("lucide-grip-vertical");
  });
});

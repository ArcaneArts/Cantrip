import type { AccountAdminSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ServerAdminPage, type ServerAdminSection } from "./server-admin-page";

const summary = {
  userCount: 4,
  licenseWhitelist: {
    enabled: true,
    adminEmail: "admin@cantrip.art",
    entries: [
      {
        id: "license-one",
        email: "member@example.com",
        registered: true,
        createdAt: "2026-08-12T12:00:00.000Z",
      },
    ],
  },
} satisfies AccountAdminSummary;

function renderAdmin(initialSection: ServerAdminSection) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(["account-admin-summary"], summary);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ServerAdminPage initialSection={initialSection} />
    </QueryClientProvider>,
  );
}

describe("server administration page", () => {
  it("renders first-class overview and signup access tabs", () => {
    const markup = renderAdmin("overview");

    expect(markup).toContain('aria-label="Server administration sections"');
    expect(markup).toContain(">Overview<");
    expect(markup).toContain(">Signup access<");
    expect(markup).toContain("Server overview");
    expect(markup).toContain("admin@cantrip.art");
    expect(markup).not.toContain('role="dialog"');
  });

  it("renders licensed account management as a dense page section", () => {
    const markup = renderAdmin("access");

    expect(markup).toContain("License an email");
    expect(markup).toContain('aria-label="Email to whitelist"');
    expect(markup).toContain("member@example.com");
    expect(markup).toContain("Registered");
  });
});

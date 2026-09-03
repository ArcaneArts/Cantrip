import { describe, expect, it } from "vitest";

import { githubOperationRequiresCheckout } from "./github-operation-scope.js";

describe("GitHub operation scope", () => {
  it.each([
    "github.auth.status",
    "github.repositories.cached",
    "github.repositories.list",
    "github.repository-owners.list",
    "github.repositories.create",
  ] as const)("runs worker-scoped operation %s without a checkout", (type) => {
    expect(githubOperationRequiresCheckout(type)).toBe(false);
  });

  it.each([
    "github.issues.list",
    "github.pull-requests.list",
    "github.actions.overview",
    "github.actions.run.checkout.prepare",
    "github.releases.list",
  ] as const)("requires a checkout for repository operation %s", (type) => {
    expect(githubOperationRequiresCheckout(type)).toBe(true);
  });

  it("does not classify Git operations as GitHub checkout operations", () => {
    expect(githubOperationRequiresCheckout("git.history")).toBe(false);
  });
});

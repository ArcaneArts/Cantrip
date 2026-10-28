import { providerAccountAuthStatus } from "../../cantrip_server/src/models/provider-account-status.ts";

export function accountAuthenticationSemantics(emit) {
  const base = {
    credentialState: "signed-out",
    planType: null,
    weeklyUsageUsedPercent: null,
    weeklyUsageResetsAt: null,
  };
  const run = (kind, account) => {
    const input = { kind, account };
    let expected;
    try {
      expected = { value: providerAccountAuthStatus(kind, account) };
    } catch (error) {
      expected = error.issues
        ? { issues: error.issues }
        : { thrown: error.name, message: error.message };
    }
    emit("account-auth-status", input, expected);
  };
  for (const kind of ["chatgpt", "grok", "other", "invalid"])
    for (const credentialState of [
      "signed-in",
      "signed-out",
      "migration-needed",
      "reauth-required",
      "conflict",
      "unknown",
    ])
      for (const planType of [null, "", "pro", "plan 🦀\ud800"])
        for (const [weeklyUsageUsedPercent, weeklyUsageResetsAt] of [
          [null, null],
          [12.34, null],
          [0, "1970-01-01T00:00:00.999Z"],
          [100, "1969-12-31T23:59:59.999Z"],
          [12.34, "2026-10-25T00:00:00.123456789Z"],
          [12.34, "invalid"],
          [100.01, null],
          [-0.01, null],
        ])
          run(kind, {
            credentialState,
            planType,
            weeklyUsageUsedPercent,
            weeklyUsageResetsAt,
          });
  for (const field of Object.keys(base)) {
    const account = { ...base };
    delete account[field];
    run("chatgpt", account);
  }
  for (const weeklyUsageResetsAt of [
    "",
    false,
    true,
    0,
    -1,
    1,
    null,
    [],
    ["2026-10-25"],
    {},
    { toString: null },
    { valueOf: 1 },
    "+275760-09-13T00:00:00.000Z",
    "-271821-04-20T00:00:00.000Z",
  ])
    run("grok", {
      ...base,
      weeklyUsageUsedPercent: 12.34,
      weeklyUsageResetsAt,
    });
  for (const weeklyUsageUsedPercent of [null, 0, "12", false, {}, [], 1e300])
    run("chatgpt", { ...base, weeklyUsageUsedPercent });
  for (const planType of [0, false, {}, [], "pro\udfff"])
    run("chatgpt", { ...base, planType });
}

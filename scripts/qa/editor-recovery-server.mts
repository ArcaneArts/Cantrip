import { runServer } from "../../cantrip_server/src/server-entry-runtime.js";

// The fixture uses the production startup path with real, shorter authority.
// Production index.ts supplies no overrides and retains its normal defaults.
void runServer({
  workerLinkTiming: { sessionLeaseMs: 45_000, sweepIntervalMs: 250 },
});

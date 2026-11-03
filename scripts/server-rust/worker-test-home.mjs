// Acceptance-only process boundary. Never preload this from a product launcher.
// Discovery must inspect disposable user config, not the developer's real home.
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
if (process.env.CANTRIP_TEST_WORKER_HOME) {
  os.homedir = () => process.env.CANTRIP_TEST_WORKER_HOME;
  syncBuiltinESMExports();
}

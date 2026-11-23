// Opt-in diagnostics for the disposable database's future connections. The
// existing restart in the product flow applies these settings before native
// execution. Production launchers and database logging defaults stay intact.
import { browserFixtureSql } from "./browser-fixture-sql.mjs";

export async function observePostgresErrors(fixture, page) {
  await browserFixtureSql(fixture, page, [
    "ALTER ROLE CURRENT_USER SET log_min_messages='error'",
    "ALTER ROLE CURRENT_USER SET log_min_error_statement='error'",
    "ALTER ROLE CURRENT_USER SET log_error_verbosity='verbose'",
  ]);
}

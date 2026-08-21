# Reproduction Steps

1. Start with the production local PGlite database created by Cantrip 1.1.659 and containing at least one row in `model_provider_accounts`.
2. Update the macOS app to 1.1.724 and allow the updater to relaunch it, or run the 1.1.724 bundled server against a disposable copy of that database with `CANTRIP_BOOTSTRAP_MODE=tauri`.
3. Observe migration `0132_polite_mongoose.sql` attempt to add `model_provider_accounts.protected_label` as `jsonb NOT NULL` while the existing row has no value for the new column.
4. Observe the bundled server exit with PostgreSQL error `23502`, followed by the Tauri setup callback returning an error and the macOS process aborting in `tao::platform_impl::platform::app_delegate::did_finish_launching`.

## Isolation check

Deleting the single legacy `model_provider_accounts` row from the disposable copy before rerunning 1.1.724 allows every pending migration to complete. The production database was not modified during this check.

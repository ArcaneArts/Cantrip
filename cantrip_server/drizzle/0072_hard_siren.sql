DROP INDEX "model_provider_accounts_provider_position_unique";--> statement-breakpoint
DROP INDEX "provider_catalog_sync_states_provider_scope_unique";--> statement-breakpoint
DROP INDEX "provider_model_availability_model_scope_unique";--> statement-breakpoint
DROP INDEX "provider_models_provider_native_unique";--> statement-breakpoint

WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY owner_id ORDER BY created_at, id) - 1 AS account_position
  FROM model_providers
  WHERE kind = 'chatgpt'
)
INSERT INTO model_provider_accounts (
  id, provider_id, label, position, credential_home_key
)
SELECT 'chatgpt-account:' || provider.id,
       provider.id,
       provider.name,
       ranked.account_position,
       provider.id
FROM model_providers provider
JOIN ranked ON ranked.id = provider.id
WHERE provider.kind = 'chatgpt'
  AND NOT EXISTS (
    SELECT 1
    FROM model_provider_accounts account
    WHERE account.provider_id = provider.id
      AND account.credential_home_key = provider.id
  );--> statement-breakpoint

WITH provider_map AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY owner_id ORDER BY created_at, id
         ) AS canonical_id
  FROM model_providers
  WHERE kind = 'chatgpt'
)
UPDATE model_provider_accounts account
SET provider_id = provider_map.canonical_id
FROM provider_map
WHERE account.provider_id = provider_map.id;--> statement-breakpoint

WITH ordered AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY provider_id ORDER BY position, created_at, id
         ) - 1 AS next_position
  FROM model_provider_accounts
)
UPDATE model_provider_accounts account
SET position = ordered.next_position
FROM ordered
WHERE account.id = ordered.id;--> statement-breakpoint

WITH provider_map AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY owner_id ORDER BY created_at, id
         ) AS canonical_id
  FROM model_providers
  WHERE kind = 'chatgpt'
)
UPDATE provider_models model
SET provider_id = provider_map.canonical_id
FROM provider_map
WHERE model.provider_id = provider_map.id;--> statement-breakpoint

WITH duplicate_models AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY provider_id, native_model_id ORDER BY created_at, id
         ) AS canonical_id
  FROM provider_models
)
DELETE FROM provider_model_availability availability
USING duplicate_models duplicate
WHERE availability.provider_model_id = duplicate.id
  AND duplicate.id <> duplicate.canonical_id
  AND EXISTS (
    SELECT 1
    FROM provider_model_availability existing
    WHERE existing.provider_model_id = duplicate.canonical_id
      AND existing.scope_key = availability.scope_key
  );--> statement-breakpoint

WITH duplicate_models AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY provider_id, native_model_id ORDER BY created_at, id
         ) AS canonical_id
  FROM provider_models
)
UPDATE provider_model_availability availability
SET provider_model_id = duplicate.canonical_id
FROM duplicate_models duplicate
WHERE availability.provider_model_id = duplicate.id
  AND duplicate.id <> duplicate.canonical_id;--> statement-breakpoint

WITH duplicate_models AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY provider_id, native_model_id ORDER BY created_at, id
         ) AS canonical_id
  FROM provider_models
)
UPDATE model_routes route
SET provider_model_id = duplicate.canonical_id
FROM duplicate_models duplicate
WHERE route.provider_model_id = duplicate.id
  AND duplicate.id <> duplicate.canonical_id;--> statement-breakpoint

WITH duplicate_models AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY provider_id, native_model_id ORDER BY created_at, id
         ) AS canonical_id
  FROM provider_models
)
INSERT INTO provider_model_suppressions (owner_id, provider_model_id)
SELECT suppression.owner_id, duplicate.canonical_id
FROM provider_model_suppressions suppression
JOIN duplicate_models duplicate ON duplicate.id = suppression.provider_model_id
WHERE duplicate.id <> duplicate.canonical_id
ON CONFLICT DO NOTHING;--> statement-breakpoint

WITH duplicate_models AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY provider_id, native_model_id ORDER BY created_at, id
         ) AS canonical_id
  FROM provider_models
)
DELETE FROM provider_model_suppressions suppression
USING duplicate_models duplicate
WHERE suppression.provider_model_id = duplicate.id
  AND duplicate.id <> duplicate.canonical_id;--> statement-breakpoint

WITH duplicate_models AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY provider_id, native_model_id ORDER BY created_at, id
         ) AS canonical_id
  FROM provider_models
)
DELETE FROM provider_models model
USING duplicate_models duplicate
WHERE model.id = duplicate.id
  AND duplicate.id <> duplicate.canonical_id;--> statement-breakpoint

WITH provider_map AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY owner_id ORDER BY created_at, id
         ) AS canonical_id
  FROM model_providers
  WHERE kind = 'chatgpt'
)
UPDATE model_routes route
SET provider_id = provider_map.canonical_id
FROM provider_map
WHERE route.provider_id = provider_map.id;--> statement-breakpoint

WITH duplicate_routes AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY model_id, provider_id, model_name
           ORDER BY position, created_at, id
         ) AS canonical_id
  FROM model_routes
)
UPDATE chat_runtime_sessions value SET model_route_id = duplicate.canonical_id
FROM duplicate_routes duplicate
WHERE value.model_route_id = duplicate.id AND duplicate.id <> duplicate.canonical_id;--> statement-breakpoint
WITH duplicate_routes AS (
  SELECT id, first_value(id) OVER (PARTITION BY model_id, provider_id, model_name ORDER BY position, created_at, id) AS canonical_id FROM model_routes
)
UPDATE chat_messages value SET model_route_id = duplicate.canonical_id FROM duplicate_routes duplicate WHERE value.model_route_id = duplicate.id AND duplicate.id <> duplicate.canonical_id;--> statement-breakpoint
WITH duplicate_routes AS (
  SELECT id, first_value(id) OVER (PARTITION BY model_id, provider_id, model_name ORDER BY position, created_at, id) AS canonical_id FROM model_routes
)
UPDATE token_usage_records value SET model_route_id = duplicate.canonical_id FROM duplicate_routes duplicate WHERE value.model_route_id = duplicate.id AND duplicate.id <> duplicate.canonical_id;--> statement-breakpoint
WITH duplicate_routes AS (
  SELECT id, first_value(id) OVER (PARTITION BY model_id, provider_id, model_name ORDER BY position, created_at, id) AS canonical_id FROM model_routes
)
UPDATE chat_relocation_snapshots value SET model_route_id = duplicate.canonical_id FROM duplicate_routes duplicate WHERE value.model_route_id = duplicate.id AND duplicate.id <> duplicate.canonical_id;--> statement-breakpoint
WITH duplicate_routes AS (
  SELECT id, first_value(id) OVER (PARTITION BY model_id, provider_id, model_name ORDER BY position, created_at, id) AS canonical_id FROM model_routes
)
UPDATE workflow_revision_nodes value SET model_route_id = duplicate.canonical_id FROM duplicate_routes duplicate WHERE value.model_route_id = duplicate.id AND duplicate.id <> duplicate.canonical_id;--> statement-breakpoint
WITH duplicate_routes AS (
  SELECT id, first_value(id) OVER (PARTITION BY model_id, provider_id, model_name ORDER BY position, created_at, id) AS canonical_id FROM model_routes
)
UPDATE workflow_run_nodes value SET model_route_id = duplicate.canonical_id FROM duplicate_routes duplicate WHERE value.model_route_id = duplicate.id AND duplicate.id <> duplicate.canonical_id;--> statement-breakpoint
WITH duplicate_routes AS (
  SELECT id, first_value(id) OVER (PARTITION BY model_id, provider_id, model_name ORDER BY position, created_at, id) AS canonical_id FROM model_routes
)
UPDATE workflow_run_node_items value SET model_route_id = duplicate.canonical_id FROM duplicate_routes duplicate WHERE value.model_route_id = duplicate.id AND duplicate.id <> duplicate.canonical_id;--> statement-breakpoint
WITH duplicate_routes AS (
  SELECT id, first_value(id) OVER (PARTITION BY model_id, provider_id, model_name ORDER BY position, created_at, id) AS canonical_id FROM model_routes
)
UPDATE workflow_node_attempts value SET model_route_id = duplicate.canonical_id FROM duplicate_routes duplicate WHERE value.model_route_id = duplicate.id AND duplicate.id <> duplicate.canonical_id;--> statement-breakpoint
WITH duplicate_routes AS (
  SELECT id, first_value(id) OVER (PARTITION BY model_id, provider_id, model_name ORDER BY position, created_at, id) AS canonical_id FROM model_routes
)
DELETE FROM model_routes route USING duplicate_routes duplicate WHERE route.id = duplicate.id AND duplicate.id <> duplicate.canonical_id;--> statement-breakpoint

WITH provider_map AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY owner_id ORDER BY created_at, id
         ) AS canonical_id
  FROM model_providers
  WHERE kind = 'chatgpt'
)
UPDATE chat_messages value SET provider_id = provider_map.canonical_id FROM provider_map WHERE value.provider_id = provider_map.id;--> statement-breakpoint
WITH provider_map AS (
  SELECT id, first_value(id) OVER (PARTITION BY owner_id ORDER BY created_at, id) AS canonical_id FROM model_providers WHERE kind = 'chatgpt'
)
UPDATE token_usage_records value SET provider_id = provider_map.canonical_id FROM provider_map WHERE value.provider_id = provider_map.id;--> statement-breakpoint
WITH provider_map AS (
  SELECT id, first_value(id) OVER (PARTITION BY owner_id ORDER BY created_at, id) AS canonical_id FROM model_providers WHERE kind = 'chatgpt'
)
UPDATE provider_catalog_sync_states value SET provider_id = provider_map.canonical_id FROM provider_map WHERE value.provider_id = provider_map.id;--> statement-breakpoint

WITH duplicates AS (
  SELECT id, row_number() OVER (PARTITION BY provider_id, scope_key ORDER BY updated_at DESC, id) AS rank
  FROM provider_catalog_sync_states
)
DELETE FROM provider_catalog_sync_states value USING duplicates duplicate WHERE value.id = duplicate.id AND duplicate.rank > 1;--> statement-breakpoint

WITH provider_map AS (
  SELECT id, first_value(id) OVER (PARTITION BY owner_id ORDER BY created_at, id) AS canonical_id FROM model_providers WHERE kind = 'chatgpt'
)
DELETE FROM model_providers provider USING provider_map WHERE provider.id = provider_map.id AND provider_map.id <> provider_map.canonical_id;--> statement-breakpoint

CREATE UNIQUE INDEX "model_provider_accounts_provider_position_unique" ON "model_provider_accounts" USING btree ("provider_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_catalog_sync_states_provider_scope_unique" ON "provider_catalog_sync_states" USING btree ("provider_id","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_model_availability_model_scope_unique" ON "provider_model_availability" USING btree ("provider_model_id","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_models_provider_native_unique" ON "provider_models" USING btree ("provider_id","native_model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_providers_owner_chatgpt_unique" ON "model_providers" USING btree ("owner_id") WHERE "model_providers"."kind" = 'chatgpt';

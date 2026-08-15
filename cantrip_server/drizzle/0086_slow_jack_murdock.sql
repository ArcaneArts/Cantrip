ALTER TABLE "model_provider_accounts" ADD COLUMN "weekly_usage_used_basis_points" integer;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD COLUMN "weekly_usage_resets_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD COLUMN "auth_last_synced_at" timestamp with time zone;--> statement-breakpoint
UPDATE "model_provider_accounts" AS "account"
SET "weekly_usage_used_basis_points" = "latest"."weekly_usage_used_basis_points",
    "weekly_usage_resets_at" = "latest"."weekly_usage_resets_at",
    "auth_last_synced_at" = "latest"."last_synced_at"
FROM (
  SELECT DISTINCT ON ("account_id")
    "account_id",
    "weekly_usage_used_basis_points",
    "weekly_usage_resets_at",
    "last_synced_at"
  FROM "model_provider_account_workers"
  ORDER BY "account_id", "last_synced_at" DESC NULLS LAST, "updated_at" DESC
) AS "latest"
WHERE "account"."id" = "latest"."account_id";--> statement-breakpoint
INSERT INTO "provider_model_availability" (
  "id", "provider_model_id", "scope_key", "worker_id",
  "provider_account_id", "state", "last_seen_at", "created_at", "updated_at"
)
SELECT
  'global-account-availability:' || md5("availability"."provider_model_id" || ':' || "availability"."provider_account_id"),
  "availability"."provider_model_id",
  "provider"."kind" || '-account:' || "availability"."provider_account_id",
  NULL,
  "availability"."provider_account_id",
  CASE
    WHEN count(*) FILTER (WHERE "availability"."state" = 'available') > 0 THEN 'available'
    WHEN count(*) FILTER (WHERE "availability"."state" = 'stale') > 0 THEN 'stale'
    ELSE 'unavailable'
  END,
  max("availability"."last_seen_at"),
  min("availability"."created_at"),
  max("availability"."updated_at")
FROM "provider_model_availability" AS "availability"
INNER JOIN "provider_models" AS "model"
  ON "model"."id" = "availability"."provider_model_id"
INNER JOIN "model_providers" AS "provider"
  ON "provider"."id" = "model"."provider_id"
WHERE "availability"."provider_account_id" IS NOT NULL
  AND "availability"."worker_id" IS NOT NULL
  AND "provider"."kind" IN ('chatgpt', 'grok')
GROUP BY "availability"."provider_model_id", "availability"."provider_account_id", "provider"."kind"
ON CONFLICT ("provider_model_id", "scope_key") DO UPDATE SET
  "worker_id" = NULL,
  "provider_account_id" = excluded."provider_account_id",
  "state" = excluded."state",
  "last_seen_at" = excluded."last_seen_at",
  "updated_at" = excluded."updated_at";--> statement-breakpoint
DELETE FROM "provider_model_availability" AS "availability"
USING "provider_models" AS "model", "model_providers" AS "provider"
WHERE "availability"."provider_model_id" = "model"."id"
  AND "model"."provider_id" = "provider"."id"
  AND "availability"."provider_account_id" IS NOT NULL
  AND "availability"."worker_id" IS NOT NULL
  AND "provider"."kind" IN ('chatgpt', 'grok');--> statement-breakpoint
INSERT INTO "provider_catalog_sync_states" (
  "id", "provider_id", "scope_key", "worker_id", "provider_account_id",
  "status", "error", "etag", "refresh_started_at", "last_success_at",
  "created_at", "updated_at"
)
SELECT
  'global-account-sync:' || md5("sync"."provider_id" || ':' || "sync"."provider_account_id"),
  "sync"."provider_id",
  "provider"."kind" || '-account:' || "sync"."provider_account_id",
  NULL,
  "sync"."provider_account_id",
  CASE
    WHEN count(*) FILTER (WHERE "sync"."status" = 'current') > 0 THEN 'current'
    WHEN count(*) FILTER (WHERE "sync"."status" = 'stale') > 0 THEN 'stale'
    WHEN count(*) FILTER (WHERE "sync"."status" = 'failed') > 0 THEN 'failed'
    ELSE 'idle'
  END,
  CASE
    WHEN count(*) FILTER (WHERE "sync"."status" = 'current') > 0 THEN NULL
    ELSE max("sync"."error")
  END,
  max("sync"."etag"),
  NULL,
  max("sync"."last_success_at"),
  min("sync"."created_at"),
  max("sync"."updated_at")
FROM "provider_catalog_sync_states" AS "sync"
INNER JOIN "model_providers" AS "provider"
  ON "provider"."id" = "sync"."provider_id"
WHERE "sync"."provider_account_id" IS NOT NULL
  AND "sync"."worker_id" IS NOT NULL
  AND "provider"."kind" IN ('chatgpt', 'grok')
GROUP BY "sync"."provider_id", "sync"."provider_account_id", "provider"."kind"
ON CONFLICT ("provider_id", "scope_key") DO UPDATE SET
  "worker_id" = NULL,
  "provider_account_id" = excluded."provider_account_id",
  "status" = excluded."status",
  "error" = excluded."error",
  "etag" = excluded."etag",
  "refresh_started_at" = NULL,
  "last_success_at" = excluded."last_success_at",
  "updated_at" = excluded."updated_at";--> statement-breakpoint
DELETE FROM "provider_catalog_sync_states" AS "sync"
USING "model_providers" AS "provider"
WHERE "sync"."provider_id" = "provider"."id"
  AND "sync"."provider_account_id" IS NOT NULL
  AND "sync"."worker_id" IS NOT NULL
  AND "provider"."kind" IN ('chatgpt', 'grok');--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD CONSTRAINT "model_provider_accounts_usage_check" CHECK ("model_provider_accounts"."weekly_usage_used_basis_points" IS NULL OR "model_provider_accounts"."weekly_usage_used_basis_points" BETWEEN 0 AND 10000);

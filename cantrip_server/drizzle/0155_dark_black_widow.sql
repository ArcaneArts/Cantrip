ALTER TABLE "account_storage_usage_snapshots" ADD COLUMN "resolution" text DEFAULT 'hour' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_storage_usage_snapshots" DROP CONSTRAINT "account_storage_usage_snapshots_owner_id_bucket_start_storage_class_category_pk";--> statement-breakpoint
ALTER TABLE "account_storage_usage_snapshots" ADD CONSTRAINT "account_storage_usage_snapshots_owner_id_bucket_start_resolution_storage_class_category_pk" PRIMARY KEY("owner_id","bucket_start","resolution","storage_class","category");--> statement-breakpoint
ALTER TABLE "account_storage_usage_snapshots" ADD CONSTRAINT "account_storage_usage_snapshots_resolution_check" CHECK ("account_storage_usage_snapshots"."resolution" IN ('hour', 'day'));

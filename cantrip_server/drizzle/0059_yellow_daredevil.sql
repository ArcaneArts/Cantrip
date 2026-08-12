ALTER TABLE "projects" ADD COLUMN "preferred_worker_id" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "default_worker_id" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "automatic_replica_provisioning" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "automatic_replica_synchronization" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_preferred_worker_id_workers_id_fk" FOREIGN KEY ("preferred_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_default_worker_id_workers_id_fk" FOREIGN KEY ("default_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_replica_synchronization_check" CHECK ("user_settings"."automatic_replica_synchronization" IN ('off', 'verify-only', 'fast-forward-primary'));--> statement-breakpoint
UPDATE "user_settings"
SET "default_worker_id" = (
	SELECT "workers"."id"
	FROM "workers"
	WHERE "workers"."owner_id" = "user_settings"."user_id"
		AND "workers"."unlinked_at" IS NULL
	ORDER BY "workers"."created_at", "workers"."id"
	LIMIT 1
)
WHERE "default_worker_id" IS NULL;

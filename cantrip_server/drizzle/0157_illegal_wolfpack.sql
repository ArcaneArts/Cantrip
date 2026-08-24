ALTER TABLE "terminals" ALTER COLUMN "protected_label" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "terminals" ALTER COLUMN "protected_state" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "terminals" ADD COLUMN "kind" text DEFAULT 'interactive' NOT NULL;--> statement-breakpoint
UPDATE "terminals" SET "kind" = 'chat-console' WHERE "linked_chat_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "terminals" ADD COLUMN "run_configuration_id" text;--> statement-breakpoint
ALTER TABLE "terminals" ADD COLUMN "run_configuration_runtime_id" text;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_run_configuration_runtime_id_run_configuration_runtimes_id_fk" FOREIGN KEY ("run_configuration_runtime_id") REFERENCES "public"."run_configuration_runtimes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_run_configuration_runtime_id_unique" UNIQUE("run_configuration_runtime_id");--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_kind_check" CHECK ("terminals"."kind" IN ('interactive', 'chat-console', 'run-configuration'));--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_kind_binding_check" CHECK ((
        ("terminals"."kind" = 'interactive' AND "terminals"."linked_chat_id" IS NULL AND "terminals"."run_configuration_id" IS NULL AND "terminals"."run_configuration_runtime_id" IS NULL AND "terminals"."protected_label" IS NOT NULL AND "terminals"."protected_state" IS NOT NULL)
        OR
        ("terminals"."kind" = 'chat-console' AND "terminals"."linked_chat_id" IS NOT NULL AND "terminals"."run_configuration_id" IS NULL AND "terminals"."run_configuration_runtime_id" IS NULL AND "terminals"."protected_label" IS NOT NULL AND "terminals"."protected_state" IS NOT NULL)
        OR
        ("terminals"."kind" = 'run-configuration' AND "terminals"."linked_chat_id" IS NULL AND "terminals"."run_configuration_id" IS NOT NULL AND "terminals"."run_configuration_runtime_id" IS NOT NULL AND "terminals"."protected_label" IS NULL AND "terminals"."protected_state" IS NULL AND "terminals"."service_enabled" = false)
      ));

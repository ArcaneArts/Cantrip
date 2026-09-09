CREATE TABLE "native_settings_evidence" (
	"event_id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"operation_generation" text NOT NULL,
	"kind" text NOT NULL,
	"submission_id" text,
	"result_digest" text NOT NULL,
	"protected_result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_settings_evidence_kind_check" CHECK ("native_settings_evidence"."kind" IN ('queued','applied','rejected','transport-lost','correlation-conflict')),
	CONSTRAINT "native_settings_evidence_digest_check" CHECK ("native_settings_evidence"."result_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "native_settings_evidence_submission_check" CHECK ("native_settings_evidence"."kind" NOT IN ('queued','applied') OR "native_settings_evidence"."submission_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "native_commands" ADD COLUMN "settings_application" jsonb;--> statement-breakpoint
ALTER TABLE "native_settings_evidence" ADD CONSTRAINT "native_settings_evidence_operation_id_native_commands_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."native_commands"("operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_settings_evidence_operation" ON "native_settings_evidence" USING btree ("operation_id");
ALTER TABLE "provider_model_suppressions" ADD COLUMN "operation" text DEFAULT 'language' NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_model_suppressions" DROP CONSTRAINT "provider_model_suppressions_owner_id_provider_model_id_pk";
--> statement-breakpoint
ALTER TABLE "provider_model_suppressions" ADD CONSTRAINT "provider_model_suppressions_operation_pk" PRIMARY KEY ("owner_id", "provider_model_id", "operation");
--> statement-breakpoint
ALTER TABLE "provider_model_suppressions" ADD CONSTRAINT "provider_model_suppressions_operation_check" CHECK ("operation" IN ('language', 'embedding', 'decision'));

ALTER TABLE "chat_import_jobs" ADD COLUMN "managed_thread_id" text;--> statement-breakpoint
ALTER TABLE "chat_import_jobs" ADD COLUMN "target_model_route_id" text;--> statement-breakpoint
ALTER TABLE "chat_import_jobs" ADD COLUMN "target_provider_account_id" text;--> statement-breakpoint
ALTER TABLE "chat_import_jobs" ADD CONSTRAINT "chat_import_jobs_target_model_route_id_model_routes_id_fk" FOREIGN KEY ("target_model_route_id") REFERENCES "public"."model_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_import_jobs" ADD CONSTRAINT "chat_import_jobs_target_provider_account_id_model_provider_accounts_id_fk" FOREIGN KEY ("target_provider_account_id") REFERENCES "public"."model_provider_accounts"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "model_routes" ADD COLUMN "operation_adapter" text;
--> statement-breakpoint
ALTER TABLE "model_routes" ADD COLUMN "operation_options" jsonb DEFAULT '{}'::jsonb NOT NULL;

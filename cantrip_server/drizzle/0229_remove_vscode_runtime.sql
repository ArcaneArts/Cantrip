-- Native Code tabs retain their identities, encrypted labels and checkout bindings.
-- Only workbench-owned runtime/session/settings state and transport resources retire.
DELETE FROM "tunnels"
WHERE "origin" = 'code' OR "managed_by_kind" = 'code' OR "destination_adapter" = 'code';
--> statement-breakpoint
DROP TABLE "code_sessions";
--> statement-breakpoint
DROP TABLE "code_settings_profiles";
--> statement-breakpoint
ALTER TABLE "workers" DROP COLUMN "code_capabilities";
--> statement-breakpoint
ALTER TABLE "code_tabs" DROP COLUMN "profile_id";
--> statement-breakpoint
ALTER TABLE "code_tabs" DROP COLUMN "theme_mode";
--> statement-breakpoint
ALTER TABLE "code_tabs" DROP COLUMN "status";
--> statement-breakpoint
ALTER TABLE "code_tabs" DROP COLUMN "last_error";
--> statement-breakpoint
ALTER TABLE "tunnels" DROP CONSTRAINT "tunnels_origin_check";
--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_origin_check"
CHECK ("origin" IN ('user', 'browser', 'project-share', 'system'));
--> statement-breakpoint
ALTER TABLE "tunnels" DROP CONSTRAINT "tunnels_destination_endpoint_check";
--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_destination_endpoint_check"
CHECK (("destination_kind" = 'worker-tcp' AND "destination_adapter" IS NULL AND "destination_resource_id" IS NULL)
  OR ("destination_kind" = 'worker-adapter' AND "destination_adapter" = 'project-share' AND "destination_resource_id" IS NOT NULL));

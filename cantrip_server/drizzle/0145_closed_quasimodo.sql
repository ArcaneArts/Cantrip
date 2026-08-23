TRUNCATE TABLE "tunnels" CASCADE;--> statement-breakpoint
ALTER TABLE "tunnel_attachments" DROP CONSTRAINT "tunnel_attachments_local_endpoint_check";--> statement-breakpoint
ALTER TABLE "tunnels" DROP CONSTRAINT "tunnels_source_worker_check";--> statement-breakpoint
ALTER TABLE "tunnel_attachments" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "tunnels" ADD COLUMN "source_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "tunnels" ADD COLUMN "source_adapter" text;--> statement-breakpoint
ALTER TABLE "tunnels" ADD COLUMN "destination_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "tunnels" ADD COLUMN "destination_adapter" text;--> statement-breakpoint
ALTER TABLE "tunnels" ADD COLUMN "destination_resource_id" text;--> statement-breakpoint
ALTER TABLE "tunnels" ADD COLUMN "protected_content" jsonb;--> statement-breakpoint
ALTER TABLE "tunnels" ADD COLUMN "protected_operation_id" text;--> statement-breakpoint
ALTER TABLE "tunnels" ADD COLUMN "protected_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tunnels" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "tunnel_attachments" DROP COLUMN "local_host";--> statement-breakpoint
ALTER TABLE "tunnel_attachments" DROP COLUMN "local_port";--> statement-breakpoint
ALTER TABLE "tunnel_attachments" DROP COLUMN "last_error";--> statement-breakpoint
ALTER TABLE "tunnels" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "tunnels" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "tunnels" DROP COLUMN "source_endpoint";--> statement-breakpoint
ALTER TABLE "tunnels" DROP COLUMN "destination_endpoint";--> statement-breakpoint
ALTER TABLE "tunnels" DROP COLUMN "last_error";--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_source_endpoint_check" CHECK (("tunnels"."source_kind" = 'server-http' AND "tunnels"."source_adapter" IN ('code', 'project-share')) OR ("tunnels"."source_kind" IN ('desktop-loopback', 'worker-listener') AND "tunnels"."source_adapter" IS NULL));--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_destination_endpoint_check" CHECK (("tunnels"."destination_kind" = 'worker-tcp' AND "tunnels"."destination_adapter" IS NULL AND "tunnels"."destination_resource_id" IS NULL) OR ("tunnels"."destination_kind" = 'worker-adapter' AND "tunnels"."destination_adapter" IN ('code', 'project-share') AND "tunnels"."destination_resource_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_protected_content_check" CHECK (("tunnels"."protected_revision" = 0 AND "tunnels"."protected_operation_id" IS NULL AND "tunnels"."protected_content" IS NULL) OR ("tunnels"."protected_revision" > 0 AND "tunnels"."protected_operation_id" IS NOT NULL AND "tunnels"."protected_content" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_private_endpoint_content_check" CHECK (("tunnels"."source_kind" <> 'worker-listener' AND "tunnels"."destination_kind" <> 'worker-tcp') OR "tunnels"."protected_revision" > 0);--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_source_worker_check" CHECK (("tunnels"."source_kind" = 'worker-listener' AND "tunnels"."source_worker_id" IS NOT NULL) OR ("tunnels"."source_kind" <> 'worker-listener' AND "tunnels"."source_worker_id" IS NULL));

DELETE FROM "tunnel_attachments" WHERE "kind" = 'server-relay';--> statement-breakpoint
DELETE FROM "tunnels" WHERE "source_kind" = 'server-http' OR "protected_revision" = 0;--> statement-breakpoint
ALTER TABLE "tunnel_attachments" DROP CONSTRAINT "tunnel_attachments_kind_check";--> statement-breakpoint
ALTER TABLE "tunnels" DROP CONSTRAINT "tunnels_source_endpoint_check";--> statement-breakpoint
ALTER TABLE "tunnels" DROP CONSTRAINT "tunnels_private_endpoint_content_check";--> statement-breakpoint
ALTER TABLE "tunnel_attachments" ADD CONSTRAINT "tunnel_attachments_kind_check" CHECK ("tunnel_attachments"."kind" = 'desktop-loopback');--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_source_endpoint_check" CHECK ("tunnels"."source_kind" IN ('desktop-loopback', 'worker-listener') AND "tunnels"."source_adapter" IS NULL);--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_private_endpoint_content_check" CHECK ("tunnels"."protected_revision" > 0);

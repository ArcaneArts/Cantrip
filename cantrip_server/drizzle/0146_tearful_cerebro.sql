ALTER TABLE "tunnels" DROP CONSTRAINT "tunnels_source_endpoint_check";--> statement-breakpoint
DELETE FROM "tunnels" WHERE "source_kind" = 'server-http' AND "source_adapter" = 'project-share';--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_source_endpoint_check" CHECK (("tunnels"."source_kind" = 'server-http' AND "tunnels"."source_adapter" = 'code') OR ("tunnels"."source_kind" IN ('desktop-loopback', 'worker-listener') AND "tunnels"."source_adapter" IS NULL));

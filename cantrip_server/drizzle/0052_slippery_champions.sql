CREATE TABLE "tunnel_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"tunnel_id" text NOT NULL,
	"kind" text NOT NULL,
	"client_id" text,
	"local_host" text,
	"local_port" integer,
	"secret_hash" text,
	"status" text DEFAULT 'starting' NOT NULL,
	"active_connection_count" integer DEFAULT 0 NOT NULL,
	"bytes_from_source" bigint DEFAULT 0 NOT NULL,
	"bytes_to_source" bigint DEFAULT 0 NOT NULL,
	"last_error" text,
	"expires_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tunnel_attachments_kind_check" CHECK ("tunnel_attachments"."kind" IN ('desktop-loopback', 'server-relay')),
	CONSTRAINT "tunnel_attachments_status_check" CHECK ("tunnel_attachments"."status" IN ('stopped', 'starting', 'active', 'offline', 'degraded', 'stopping', 'failed')),
	CONSTRAINT "tunnel_attachments_local_endpoint_check" CHECK (("tunnel_attachments"."kind" = 'desktop-loopback' AND "tunnel_attachments"."client_id" IS NOT NULL AND "tunnel_attachments"."local_host" IN ('127.0.0.1', 'localhost', '::1') AND "tunnel_attachments"."local_port" BETWEEN 1 AND 65535) OR ("tunnel_attachments"."kind" = 'server-relay' AND "tunnel_attachments"."client_id" IS NULL AND "tunnel_attachments"."local_host" IS NULL AND "tunnel_attachments"."local_port" IS NULL)),
	CONSTRAINT "tunnel_attachments_active_connections_check" CHECK ("tunnel_attachments"."active_connection_count" >= 0),
	CONSTRAINT "tunnel_attachments_bytes_from_source_check" CHECK ("tunnel_attachments"."bytes_from_source" >= 0),
	CONSTRAINT "tunnel_attachments_bytes_to_source_check" CHECK ("tunnel_attachments"."bytes_to_source" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tunnels" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"description" text,
	"position" integer DEFAULT 0 NOT NULL,
	"origin" text NOT NULL,
	"management" text NOT NULL,
	"protocol_hint" text NOT NULL,
	"source_endpoint" jsonb NOT NULL,
	"source_worker_id" text,
	"destination_endpoint" jsonb NOT NULL,
	"destination_worker_id" text NOT NULL,
	"managed_by_kind" text,
	"managed_by_id" text,
	"desired_state" text DEFAULT 'stopped' NOT NULL,
	"status" text DEFAULT 'stopped' NOT NULL,
	"last_error" text,
	"active_connection_count" integer DEFAULT 0 NOT NULL,
	"bytes_from_source" bigint DEFAULT 0 NOT NULL,
	"bytes_to_source" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tunnels_origin_check" CHECK ("tunnels"."origin" IN ('user', 'browser', 'project-share', 'code', 'workflow', 'system')),
	CONSTRAINT "tunnels_management_check" CHECK ("tunnels"."management" IN ('user-managed', 'managed-durable', 'managed-ephemeral')),
	CONSTRAINT "tunnels_protocol_hint_check" CHECK ("tunnels"."protocol_hint" IN ('tcp', 'http', 'https', 'http-websocket', 'https-websocket', 'webdav')),
	CONSTRAINT "tunnels_desired_state_check" CHECK ("tunnels"."desired_state" IN ('stopped', 'started')),
	CONSTRAINT "tunnels_status_check" CHECK ("tunnels"."status" IN ('stopped', 'starting', 'active', 'offline', 'degraded', 'stopping', 'failed')),
	CONSTRAINT "tunnels_managed_resource_check" CHECK (("tunnels"."management" = 'user-managed' AND "tunnels"."origin" = 'user' AND "tunnels"."managed_by_kind" IS NULL AND "tunnels"."managed_by_id" IS NULL) OR ("tunnels"."management" <> 'user-managed' AND "tunnels"."origin" <> 'user' AND "tunnels"."origin" = "tunnels"."managed_by_kind" AND "tunnels"."managed_by_id" IS NOT NULL)),
	CONSTRAINT "tunnels_source_worker_check" CHECK (("tunnels"."source_endpoint"->>'kind' = 'worker-listener' AND "tunnels"."source_worker_id" IS NOT NULL) OR ("tunnels"."source_endpoint"->>'kind' <> 'worker-listener' AND "tunnels"."source_worker_id" IS NULL)),
	CONSTRAINT "tunnels_active_connections_check" CHECK ("tunnels"."active_connection_count" >= 0),
	CONSTRAINT "tunnels_bytes_from_source_check" CHECK ("tunnels"."bytes_from_source" >= 0),
	CONSTRAINT "tunnels_bytes_to_source_check" CHECK ("tunnels"."bytes_to_source" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tunnel_attachments" ADD CONSTRAINT "tunnel_attachments_tunnel_id_tunnels_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "public"."tunnels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_source_worker_id_workers_id_fk" FOREIGN KEY ("source_worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_destination_worker_id_workers_id_fk" FOREIGN KEY ("destination_worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tunnel_attachments_tunnel_status_index" ON "tunnel_attachments" USING btree ("tunnel_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tunnel_attachments_tunnel_client_unique" ON "tunnel_attachments" USING btree ("tunnel_id","client_id") WHERE "tunnel_attachments"."client_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tunnel_attachments_secret_hash_unique" ON "tunnel_attachments" USING btree ("secret_hash") WHERE "tunnel_attachments"."secret_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tunnels_owner_position_index" ON "tunnels" USING btree ("owner_id","position");--> statement-breakpoint
CREATE INDEX "tunnels_owner_project_index" ON "tunnels" USING btree ("owner_id","project_id","position");--> statement-breakpoint
CREATE INDEX "tunnels_destination_worker_index" ON "tunnels" USING btree ("destination_worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tunnels_managed_resource_unique" ON "tunnels" USING btree ("owner_id","managed_by_kind","managed_by_id") WHERE "tunnels"."managed_by_kind" IS NOT NULL;
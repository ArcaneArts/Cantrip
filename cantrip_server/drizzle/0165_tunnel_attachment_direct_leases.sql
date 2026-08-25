CREATE TABLE "tunnel_attachment_direct_leases" (
	"capability_id" text PRIMARY KEY NOT NULL,
	"attachment_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tunnel_attachment_direct_leases_status_check" CHECK ("tunnel_attachment_direct_leases"."status" IN ('active', 'finalized')),
	CONSTRAINT "tunnel_attachment_direct_leases_finalized_at_check" CHECK (("tunnel_attachment_direct_leases"."status" = 'active' AND "tunnel_attachment_direct_leases"."finalized_at" IS NULL) OR ("tunnel_attachment_direct_leases"."status" = 'finalized' AND "tunnel_attachment_direct_leases"."finalized_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "tunnel_attachment_direct_leases" ADD CONSTRAINT "tunnel_attachment_direct_leases_attachment_id_tunnel_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."tunnel_attachments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "tunnel_attachment_direct_leases_attachment_status_expiry_index" ON "tunnel_attachment_direct_leases" USING btree ("attachment_id", "status", "lease_expires_at");

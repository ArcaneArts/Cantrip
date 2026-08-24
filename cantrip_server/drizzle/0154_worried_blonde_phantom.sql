CREATE TABLE "account_bandwidth_flushes" (
	"meter_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"entry_count" integer NOT NULL,
	"bytes" bigint NOT NULL,
	"flushed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_bandwidth_flushes_meter_id_sequence_pk" PRIMARY KEY("meter_id","sequence"),
	CONSTRAINT "account_bandwidth_flushes_entries_check" CHECK ("account_bandwidth_flushes"."entry_count" >= 0),
	CONSTRAINT "account_bandwidth_flushes_bytes_check" CHECK ("account_bandwidth_flushes"."bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "account_bandwidth_usage_buckets" (
	"owner_id" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"resolution" text DEFAULT 'hour' NOT NULL,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"operation_count" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_bandwidth_usage_buckets_owner_id_bucket_start_resolution_channel_direction_pk" PRIMARY KEY("owner_id","bucket_start","resolution","channel","direction"),
	CONSTRAINT "account_bandwidth_usage_resolution_check" CHECK ("account_bandwidth_usage_buckets"."resolution" IN ('hour', 'day')),
	CONSTRAINT "account_bandwidth_usage_channel_check" CHECK ("account_bandwidth_usage_buckets"."channel" IN ('http', 'client-live-websocket', 'worker-control-websocket', 'worker-log-stream', 'terminal-relay', 'remote-surface-relay', 'tunnel-relay', 'attachment-transfer', 'code-relay', 'project-share-relay', 'other')),
	CONSTRAINT "account_bandwidth_usage_direction_check" CHECK ("account_bandwidth_usage_buckets"."direction" IN ('ingress', 'egress')),
	CONSTRAINT "account_bandwidth_usage_bytes_check" CHECK ("account_bandwidth_usage_buckets"."bytes" >= 0),
	CONSTRAINT "account_bandwidth_usage_operations_check" CHECK ("account_bandwidth_usage_buckets"."operation_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "account_bandwidth_usage_buckets" ADD CONSTRAINT "account_bandwidth_usage_buckets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_bandwidth_flushes_time_index" ON "account_bandwidth_flushes" USING btree ("flushed_at");--> statement-breakpoint
CREATE INDEX "account_bandwidth_usage_owner_time_index" ON "account_bandwidth_usage_buckets" USING btree ("owner_id","bucket_start");
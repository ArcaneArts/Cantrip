CREATE TABLE "account_storage_reconciliation_leases" (
	"key" text PRIMARY KEY NOT NULL,
	"holder_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_storage_usage_current" (
	"owner_id" text NOT NULL,
	"storage_class" text NOT NULL,
	"category" text NOT NULL,
	"logical_bytes" bigint DEFAULT 0 NOT NULL,
	"row_count" bigint DEFAULT 0 NOT NULL,
	"basis_version" text NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"reconciled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_storage_usage_current_owner_id_storage_class_category_pk" PRIMARY KEY("owner_id","storage_class","category"),
	CONSTRAINT "account_storage_usage_current_class_check" CHECK ("account_storage_usage_current"."storage_class" IN ('server', 'worker-managed')),
	CONSTRAINT "account_storage_usage_current_bytes_check" CHECK ("account_storage_usage_current"."logical_bytes" >= 0),
	CONSTRAINT "account_storage_usage_current_rows_check" CHECK ("account_storage_usage_current"."row_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "account_storage_usage_snapshots" (
	"owner_id" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"storage_class" text NOT NULL,
	"category" text NOT NULL,
	"logical_bytes" bigint DEFAULT 0 NOT NULL,
	"row_count" bigint DEFAULT 0 NOT NULL,
	"basis_version" text NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_storage_usage_snapshots_owner_id_bucket_start_storage_class_category_pk" PRIMARY KEY("owner_id","bucket_start","storage_class","category"),
	CONSTRAINT "account_storage_usage_snapshots_class_check" CHECK ("account_storage_usage_snapshots"."storage_class" IN ('server', 'worker-managed')),
	CONSTRAINT "account_storage_usage_snapshots_bytes_check" CHECK ("account_storage_usage_snapshots"."logical_bytes" >= 0),
	CONSTRAINT "account_storage_usage_snapshots_rows_check" CHECK ("account_storage_usage_snapshots"."row_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "workers" ALTER COLUMN "codex_runtime" SET DEFAULT '{"adapter":"app-server","compatibility":"missing","version":null,"testedRange":">=0.149.0 <0.150.0","initialize":null,"methods":{},"features":[],"nativeSubagents":{"available":false,"protocolVersion":null,"reason":"This worker has not reported native subagent capability."},"degradedReasons":["This worker has not reported runtime compatibility."]}'::jsonb;--> statement-breakpoint
ALTER TABLE "account_storage_usage_current" ADD CONSTRAINT "account_storage_usage_current_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_storage_usage_snapshots" ADD CONSTRAINT "account_storage_usage_snapshots_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_storage_reconciliation_leases_expiry_index" ON "account_storage_reconciliation_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "account_storage_usage_current_owner_measured_index" ON "account_storage_usage_current" USING btree ("owner_id","measured_at");--> statement-breakpoint
CREATE INDEX "account_storage_usage_snapshots_owner_time_index" ON "account_storage_usage_snapshots" USING btree ("owner_id","bucket_start");
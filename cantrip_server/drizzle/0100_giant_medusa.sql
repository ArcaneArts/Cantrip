CREATE TABLE "account_encryption_profiles" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"format_version" integer NOT NULL,
	"active_master_key_revision" integer NOT NULL,
	"password_kdf" jsonb,
	"password_wrapped_master_key" jsonb,
	"initialization_status" text DEFAULT 'initialized' NOT NULL,
	"payload_migration_status" text DEFAULT 'pending' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_encryption_profiles_format_version_check" CHECK ("account_encryption_profiles"."format_version" = 1),
	CONSTRAINT "account_encryption_profiles_key_revision_check" CHECK ("account_encryption_profiles"."active_master_key_revision" >= 1 AND "account_encryption_profiles"."revision" >= 1),
	CONSTRAINT "account_encryption_profiles_password_wrapper_pair_check" CHECK (("account_encryption_profiles"."password_kdf" IS NULL) = ("account_encryption_profiles"."password_wrapped_master_key" IS NULL)),
	CONSTRAINT "account_encryption_profiles_initialization_status_check" CHECK ("account_encryption_profiles"."initialization_status" = 'initialized'),
	CONSTRAINT "account_encryption_profiles_migration_status_check" CHECK ("account_encryption_profiles"."payload_migration_status" IN ('pending', 'in-progress', 'complete'))
);
--> statement-breakpoint
CREATE TABLE "encryption_key_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"component" text NOT NULL,
	"key_revision" integer NOT NULL,
	"wrapped_key" jsonb NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encryption_key_grants_revision_check" CHECK ("encryption_key_grants"."key_revision" >= 1 AND "encryption_key_grants"."revision" >= 1),
	CONSTRAINT "encryption_key_grants_state_check" CHECK ("encryption_key_grants"."state" IN ('active', 'revoked')),
	CONSTRAINT "encryption_key_grants_state_timestamp_check" CHECK (("encryption_key_grants"."state" = 'active' AND "encryption_key_grants"."revoked_at" IS NULL) OR ("encryption_key_grants"."state" = 'revoked' AND "encryption_key_grants"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "encryption_principals" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"worker_id" text,
	"label" text,
	"public_key" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encryption_principals_kind_worker_check" CHECK (("encryption_principals"."kind" = 'client' AND "encryption_principals"."worker_id" IS NULL) OR ("encryption_principals"."kind" = 'worker' AND "encryption_principals"."worker_id" IS NOT NULL)),
	CONSTRAINT "encryption_principals_state_check" CHECK ("encryption_principals"."state" IN ('pending', 'approved', 'revoked')),
	CONSTRAINT "encryption_principals_revision_check" CHECK ("encryption_principals"."revision" >= 1),
	CONSTRAINT "encryption_principals_state_timestamps_check" CHECK (("encryption_principals"."state" = 'pending' AND "encryption_principals"."approved_at" IS NULL AND "encryption_principals"."revoked_at" IS NULL) OR ("encryption_principals"."state" = 'approved' AND "encryption_principals"."approved_at" IS NOT NULL AND "encryption_principals"."revoked_at" IS NULL) OR ("encryption_principals"."state" = 'revoked' AND "encryption_principals"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "account_encryption_profiles" ADD CONSTRAINT "account_encryption_profiles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encryption_key_grants" ADD CONSTRAINT "encryption_key_grants_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encryption_key_grants" ADD CONSTRAINT "encryption_key_grants_principal_id_encryption_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."encryption_principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encryption_principals" ADD CONSTRAINT "encryption_principals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encryption_principals" ADD CONSTRAINT "encryption_principals_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "encryption_key_grants_principal_component_revision_unique" ON "encryption_key_grants" USING btree ("principal_id","component","key_revision");--> statement-breakpoint
CREATE INDEX "encryption_key_grants_owner_principal_state_index" ON "encryption_key_grants" USING btree ("owner_id","principal_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "encryption_principals_worker_unique" ON "encryption_principals" USING btree ("owner_id","worker_id") WHERE "encryption_principals"."worker_id" IS NOT NULL AND "encryption_principals"."state" <> 'revoked';--> statement-breakpoint
CREATE INDEX "encryption_principals_owner_state_index" ON "encryption_principals" USING btree ("owner_id","state");
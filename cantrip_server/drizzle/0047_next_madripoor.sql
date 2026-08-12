CREATE TABLE "user_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"auth_method" text NOT NULL,
	"label" text,
	"user_agent_hash" text,
	"ip_address_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sessions_auth_method_check" CHECK ("user_sessions"."auth_method" IN ('password', 'account-password'))
);
--> statement-breakpoint
CREATE TABLE "worker_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"label" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"replaces_credential_id" text,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_enrollment_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"created_by_session_id" text,
	"code_hash" text NOT NULL,
	"label" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "normalized_email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "users" SET "normalized_email" = lower("email") WHERE "email" IS NOT NULL;--> statement-breakpoint
UPDATE "users" SET "role" = 'owner' WHERE "kind" = 'anonymous';--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_credentials" ADD CONSTRAINT "worker_credentials_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_credentials" ADD CONSTRAINT "worker_credentials_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_enrollment_codes" ADD CONSTRAINT "worker_enrollment_codes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_enrollment_codes" ADD CONSTRAINT "worker_enrollment_codes_created_by_session_id_user_sessions_id_fk" FOREIGN KEY ("created_by_session_id") REFERENCES "public"."user_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_sessions_token_hash_unique" ON "user_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_sessions_user_active_index" ON "user_sessions" USING btree ("user_id","revoked_at","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_credentials_secret_hash_unique" ON "worker_credentials" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "worker_credentials_owner_worker_index" ON "worker_credentials" USING btree ("owner_id","worker_id");--> statement-breakpoint
CREATE INDEX "worker_credentials_worker_active_index" ON "worker_credentials" USING btree ("worker_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_enrollment_codes_hash_unique" ON "worker_enrollment_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "worker_enrollment_codes_owner_expiry_index" ON "worker_enrollment_codes" USING btree ("owner_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_normalized_email_unique" ON "users" USING btree ("normalized_email") WHERE "users"."normalized_email" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_kind_check" CHECK ("users"."kind" IN ('anonymous', 'account'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('owner', 'admin', 'member'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_status_check" CHECK ("users"."status" IN ('active', 'disabled'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_email_check" CHECK ("users"."kind" <> 'account' OR "users"."normalized_email" IS NOT NULL);

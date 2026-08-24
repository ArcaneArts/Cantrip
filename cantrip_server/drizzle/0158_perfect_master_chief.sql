CREATE TABLE "run_configuration_secret_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text NOT NULL,
	"reference" text NOT NULL,
	"revision" integer,
	"protected_value_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_configuration_secret_operations_id_check" CHECK ("run_configuration_secret_operations"."id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "run_configuration_secret_operations_reference_check" CHECK (char_length("run_configuration_secret_operations"."reference") BETWEEN 1 AND 256 AND "run_configuration_secret_operations"."reference" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$' AND "run_configuration_secret_operations"."reference" !~ '/$' AND "run_configuration_secret_operations"."reference" !~ '(^|/)(\.|\.\.)(/|$)' AND "run_configuration_secret_operations"."reference" !~ '//'),
	CONSTRAINT "run_configuration_secret_operations_revision_check" CHECK ("run_configuration_secret_operations"."revision" IS NULL OR "run_configuration_secret_operations"."revision" > 0),
	CONSTRAINT "run_configuration_secret_operations_digest_check" CHECK ("run_configuration_secret_operations"."protected_value_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "run_configuration_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text NOT NULL,
	"reference" text NOT NULL,
	"protected_value" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_configuration_secrets_id_check" CHECK ("run_configuration_secrets"."id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "run_configuration_secrets_reference_check" CHECK (char_length("run_configuration_secrets"."reference") BETWEEN 1 AND 256 AND "run_configuration_secrets"."reference" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$' AND "run_configuration_secrets"."reference" !~ '/$' AND "run_configuration_secrets"."reference" !~ '(^|/)(\.|\.\.)(/|$)' AND "run_configuration_secrets"."reference" !~ '//'),
	CONSTRAINT "run_configuration_secrets_revision_check" CHECK ("run_configuration_secrets"."revision" > 0),
	CONSTRAINT "run_configuration_secrets_value_check" CHECK (octet_length("run_configuration_secrets"."protected_value"::text) <= 100000)
);
--> statement-breakpoint
ALTER TABLE "run_configuration_secret_operations" ADD CONSTRAINT "run_configuration_secret_operations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_configuration_secret_operations" ADD CONSTRAINT "run_configuration_secret_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_configuration_secrets" ADD CONSTRAINT "run_configuration_secrets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_configuration_secrets" ADD CONSTRAINT "run_configuration_secrets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_configuration_secret_operations_project_reference_index" ON "run_configuration_secret_operations" USING btree ("project_id","reference","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_configuration_secrets_project_reference_unique" ON "run_configuration_secrets" USING btree ("project_id","reference");--> statement-breakpoint
CREATE INDEX "run_configuration_secrets_owner_project_index" ON "run_configuration_secrets" USING btree ("owner_id","project_id","updated_at");
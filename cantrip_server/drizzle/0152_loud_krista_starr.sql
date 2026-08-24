CREATE TABLE "code_settings_profiles" (
	"owner_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"revision" integer NOT NULL,
	"protected_operation_id" text NOT NULL,
	"protected_content" jsonb NOT NULL,
	"updated_by_worker_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_settings_profiles_owner_id_profile_id_pk" PRIMARY KEY("owner_id","profile_id"),
	CONSTRAINT "code_settings_profiles_profile_check" CHECK ("code_settings_profiles"."profile_id" = 'default'),
	CONSTRAINT "code_settings_profiles_revision_check" CHECK ("code_settings_profiles"."revision" > 0),
	CONSTRAINT "code_settings_profiles_domain_check" CHECK ("code_settings_profiles"."protected_content"->>'domain' = 'customization-content')
);
--> statement-breakpoint
ALTER TABLE "code_settings_profiles" ADD CONSTRAINT "code_settings_profiles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_settings_profiles" ADD CONSTRAINT "code_settings_profiles_updated_by_worker_id_workers_id_fk" FOREIGN KEY ("updated_by_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "code_settings_profiles_owner_operation_unique" ON "code_settings_profiles" USING btree ("owner_id","protected_operation_id");

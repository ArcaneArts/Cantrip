CREATE TABLE "project_dock_presentation_preferences" (
	"project_id" text NOT NULL,
	"tab_key" text NOT NULL,
	"region" text NOT NULL,
	"preferred_mode" text NOT NULL,
	"split_fraction" double precision NOT NULL,
	"restore_fraction" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_dock_presentation_preferences_project_id_tab_key_region_pk" PRIMARY KEY("project_id","tab_key","region"),
	CONSTRAINT "project_dock_presentation_preferences_region_check" CHECK ("project_dock_presentation_preferences"."region" IN ('right', 'bottom')),
	CONSTRAINT "project_dock_presentation_preferences_mode_check" CHECK ("project_dock_presentation_preferences"."preferred_mode" IN ('closed', 'split', 'full')),
	CONSTRAINT "project_dock_presentation_preferences_split_fraction_check" CHECK ("project_dock_presentation_preferences"."split_fraction" BETWEEN 0.05 AND 0.95),
	CONSTRAINT "project_dock_presentation_preferences_restore_fraction_check" CHECK ("project_dock_presentation_preferences"."restore_fraction" BETWEEN 0.05 AND 0.95)
);
--> statement-breakpoint
ALTER TABLE "project_dock_presentation_preferences" ADD CONSTRAINT "project_dock_presentation_preferences_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
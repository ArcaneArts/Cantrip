ALTER TABLE "browsers" ADD COLUMN "protected_label" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "code_tabs" ADD COLUMN "protected_label" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "explorers" ADD COLUMN "protected_label" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_views" ADD COLUMN "protected_label" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_surfaces" ADD COLUMN "protected_label" jsonb;--> statement-breakpoint
ALTER TABLE "terminals" ADD COLUMN "protected_label" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "browsers" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "code_tabs" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "explorers" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "project_views" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "remote_surfaces" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "terminals" DROP COLUMN "title";
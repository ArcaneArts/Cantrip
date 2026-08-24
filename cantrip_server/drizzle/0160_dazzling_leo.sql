ALTER TABLE "task_planning_rounds" DROP CONSTRAINT "task_planning_rounds_kind_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_active_operation_kind_check";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "plan_goal_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "tasks" SET "plan_goal_enabled" = true;--> statement-breakpoint
ALTER TABLE "task_planning_rounds" ADD CONSTRAINT "task_planning_rounds_kind_check" CHECK ("task_planning_rounds"."kind" IN ('direct', 'initial-plan', 'continue-plan', 'finalize'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_active_operation_kind_check" CHECK ("tasks"."active_operation_kind" IS NULL OR "tasks"."active_operation_kind" IN ('direct', 'initial-plan', 'continue-plan', 'finalize'));

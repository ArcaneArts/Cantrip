-- Pre-release reset: remove only Task-experience chats and their cascading Task,
-- planning-round, message, lane, runtime, and tab dependencies. Accounts,
-- encryption custody, projects, and ordinary agent chats are intentionally kept.
DELETE FROM "chats" WHERE "experience" = 'task';--> statement-breakpoint
ALTER TABLE "task_planning_rounds" DROP CONSTRAINT "task_planning_rounds_input_brief_length_check";--> statement-breakpoint
ALTER TABLE "task_planning_rounds" DROP CONSTRAINT "task_planning_rounds_input_plan_length_check";--> statement-breakpoint
ALTER TABLE "task_planning_rounds" DROP CONSTRAINT "task_planning_rounds_output_plan_length_check";--> statement-breakpoint
ALTER TABLE "task_planning_rounds" DROP CONSTRAINT "task_planning_rounds_goal_prompt_length_check";--> statement-breakpoint
ALTER TABLE "task_planning_rounds" DROP CONSTRAINT "task_planning_rounds_direction_length_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_brief_length_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_plan_length_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_final_plan_length_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_goal_prompt_length_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_direction_length_check";--> statement-breakpoint
ALTER TABLE "task_planning_rounds" ADD COLUMN "has_output_plan" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_planning_rounds" ADD COLUMN "has_output_questions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_planning_rounds" ADD COLUMN "has_output_goal_prompt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_planning_rounds" ADD COLUMN "protected_content" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_planning_rounds" ADD COLUMN "relay_request" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_planning_rounds" ADD COLUMN "relay_result" jsonb;--> statement-breakpoint
ALTER TABLE "task_planning_rounds" ADD COLUMN "failure_task" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_planning_rounds" ADD COLUMN "failure_round" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "has_plan" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "has_questions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "has_final_plan" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "has_goal_prompt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "protected_content" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_planning_rounds" DROP COLUMN "input_brief_markdown";--> statement-breakpoint
ALTER TABLE "task_planning_rounds" DROP COLUMN "input_plan_markdown";--> statement-breakpoint
ALTER TABLE "task_planning_rounds" DROP COLUMN "input_questions";--> statement-breakpoint
ALTER TABLE "task_planning_rounds" DROP COLUMN "input_answers";--> statement-breakpoint
ALTER TABLE "task_planning_rounds" DROP COLUMN "additional_direction";--> statement-breakpoint
ALTER TABLE "task_planning_rounds" DROP COLUMN "output_plan_markdown";--> statement-breakpoint
ALTER TABLE "task_planning_rounds" DROP COLUMN "output_questions";--> statement-breakpoint
ALTER TABLE "task_planning_rounds" DROP COLUMN "output_goal_prompt";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "brief_markdown";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "plan_markdown";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "current_questions";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "current_answers";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "additional_direction";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "final_plan_markdown";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "goal_prompt";

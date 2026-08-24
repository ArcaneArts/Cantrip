ALTER TABLE "task_dispatch_cycles" ADD COLUMN "operation_id" text;--> statement-breakpoint
UPDATE "task_dispatch_cycles" SET "operation_id" = "id" WHERE "operation_id" IS NULL;--> statement-breakpoint
ALTER TABLE "task_dispatch_cycles" ALTER COLUMN "operation_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "task_dispatch_cycles_operation_index" ON "task_dispatch_cycles" USING btree ("chat_id","operation_id");

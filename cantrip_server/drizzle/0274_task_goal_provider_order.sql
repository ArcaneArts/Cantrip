ALTER TABLE task_dispatch_cycles
  ADD COLUMN goal_order_epoch bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE task_dispatch_cycles
  ADD CONSTRAINT task_dispatch_cycles_goal_order_epoch_check
  CHECK (goal_order_epoch BETWEEN 0 AND 9007199254740991);

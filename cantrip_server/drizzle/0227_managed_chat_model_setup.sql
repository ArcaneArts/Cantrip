ALTER TABLE "managed_chat_preparations" DROP CONSTRAINT "managed_chat_preparations_phase_check";
--> statement-breakpoint
ALTER TABLE "managed_chat_preparations" ADD CONSTRAINT "managed_chat_preparations_phase_check" CHECK ("phase" IN ('pending','thread','console','ready','failed','needs-model'));

ALTER TABLE cantrip_os_backup_operations DROP CONSTRAINT cantrip_os_backup_action_check;
--> statement-breakpoint
ALTER TABLE cantrip_os_backup_operations ADD CONSTRAINT cantrip_os_backup_action_check CHECK (
    (action IN ('capture', 'reset') AND backup_id IS NULL AND restore_operation_id IS NULL)
    OR (action = 'restore' AND backup_id IS NOT NULL AND restore_operation_id IS NULL)
    OR (action = 'rollback' AND backup_id IS NULL AND restore_operation_id IS NOT NULL)
);

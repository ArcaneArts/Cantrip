-- Acquire the active-path guard's worker lock before canonical registration
-- takes a foreign-key key-share lock on that same worker row.
ALTER TRIGGER "project_source_register_local" ON "project_sources"
RENAME TO "project_sources_z_register_local";

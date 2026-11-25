ALTER TABLE user_settings
    ADD COLUMN default_council_model_id text REFERENCES model_profiles(id) ON DELETE SET NULL,
    ADD COLUMN default_council_permission_profile_id text NOT NULL DEFAULT ':workspace',
    ADD CONSTRAINT user_settings_council_permission_profile_check
        CHECK (default_council_permission_profile_id IN (':read-only', ':workspace', ':danger-full-access', ':yolo'));

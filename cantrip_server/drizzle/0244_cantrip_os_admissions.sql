CREATE TABLE cantrip_os_provision_admissions (
  operation_id text PRIMARY KEY,
  binding_id text NOT NULL UNIQUE REFERENCES cantrip_os_source_bindings(id) ON DELETE CASCADE,
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  protected_request jsonb NOT NULL CHECK (jsonb_typeof(protected_request) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE FUNCTION cantrip_os_immutable_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OS provisioning admissions are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cantrip_os_immutable_admission BEFORE UPDATE ON cantrip_os_provision_admissions
FOR EACH ROW EXECUTE FUNCTION cantrip_os_immutable_admission();

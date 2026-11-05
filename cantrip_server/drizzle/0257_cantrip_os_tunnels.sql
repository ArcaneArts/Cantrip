ALTER TABLE tunnels ADD COLUMN os_source jsonb;
--> statement-breakpoint
ALTER TABLE tunnel_attachments ADD COLUMN os_service_identity text;
--> statement-breakpoint
ALTER TABLE tunnels DROP CONSTRAINT tunnels_destination_endpoint_check;
--> statement-breakpoint
ALTER TABLE tunnels ADD CONSTRAINT tunnels_destination_endpoint_check CHECK (
  (destination_kind = 'worker-tcp' AND destination_adapter IS NULL AND destination_resource_id IS NULL)
  OR (destination_kind = 'worker-adapter' AND destination_adapter IN ('project-share', 'cantrip-os') AND destination_resource_id IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE tunnels ADD CONSTRAINT tunnels_os_source_check CHECK (
  COALESCE(destination_adapter = 'cantrip-os', false) = (os_source IS NOT NULL)
  AND (os_source IS NULL OR (
    cantrip_os_desktop_configuration_valid(jsonb_build_object('kind','desktop','osSource',os_source))
    AND NOT os_source ? 'desktopGeneration'
    AND destination_resource_id = id
  ))
);

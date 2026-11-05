ALTER TABLE tunnels DROP CONSTRAINT tunnels_os_source_check;
--> statement-breakpoint
ALTER TABLE tunnels ADD CONSTRAINT tunnels_os_source_check CHECK (
  (NOT COALESCE(destination_adapter = 'cantrip-os', false) OR os_source IS NOT NULL)
  AND (os_source IS NULL OR (
    cantrip_os_desktop_configuration_valid(jsonb_build_object('kind','desktop','osSource',os_source))
    AND NOT os_source ? 'desktopGeneration'
    AND (
      (source_kind = 'desktop-loopback' AND destination_kind = 'worker-adapter' AND destination_adapter = 'cantrip-os' AND destination_resource_id = id)
      OR (source_kind = 'worker-listener' AND destination_kind = 'worker-tcp' AND source_worker_id = destination_worker_id)
    )
  ))
);
--> statement-breakpoint
ALTER TABLE tunnel_attachments DROP CONSTRAINT tunnel_attachments_kind_check;
--> statement-breakpoint
ALTER TABLE tunnel_attachments ADD CONSTRAINT tunnel_attachments_kind_check CHECK (kind IN ('desktop-loopback','worker-listener'));

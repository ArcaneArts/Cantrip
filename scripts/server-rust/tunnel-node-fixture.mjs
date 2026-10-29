// Actual repository methods under a deterministic wall clock, restored before
// the next request. No SQL/transaction or lifecycle implementation is replaced.
export async function tunnelOperation(repository, request) {
  const OriginalDate = Date,
    now = new OriginalDate(request.now).getTime();
  // Return ordinary Date instances: PostgreSQL parameter inference must also
  // recognize dates parsed in an earlier operation, after its clock restored.
  globalThis.Date = request.realClock
    ? OriginalDate
    : new Proxy(OriginalDate, {
        construct(target, args) {
          return new target(...(args.length ? args : [now]));
        },
        get(target, key) {
          return key === "now" ? () => now : Reflect.get(target, key);
        },
      });
  try {
    const { owner, attachment: id } = request,
      repo = repository;
    switch (request.op) {
      case "tunnel-list":
        return await repo.listTunnels(owner, request.project);
      case "tunnel-get":
        return await repo.getTunnel(owner, request.tunnel);
      case "tunnel-create":
        return await repo.createUserTunnel(owner, request.input);
      case "tunnel-update":
        return await repo.updateUserTunnel(
          owner,
          request.tunnel,
          request.input,
        );
      case "tunnel-delete":
        return await repo.deleteUserTunnel(owner, request.tunnel);
      case "tunnel-managed-register":
        return await repo.registerManagedTunnel(
          owner,
          request.input,
          request.protected,
        );
      case "tunnel-managed-get":
        return await repo.getManagedTunnel(owner, request.managedBy);
      case "tunnel-managed-remove":
        return await repo.removeManagedTunnel(owner, request.managedBy);
      case "tunnel-attachment-get":
        return await repo.getDesktopTunnelAttachment(owner, id);
      case "tunnel-attachment-authorize":
        return await repo.authorizeDesktopTunnelAttachment(id, request.hash);
      case "tunnel-attachment-create":
        return await repo.createDesktopTunnelAttachment(owner, request.tunnel, {
          ...request.input,
          expiresAt: new Date(request.input.expiresAt),
          secretExpiresAt: new Date(request.input.secretExpiresAt),
        });
      case "tunnel-attachment-activate":
        return await repo.activateDesktopTunnelAttachment(
          id,
          request.client,
          new Date(request.secret),
        );
      case "tunnel-attachment-offline":
        return await repo.markDesktopTunnelAttachmentOffline(
          id,
          new Date(request.secret),
          new Date(request.activated),
        );
      case "tunnel-attachment-stop":
        return await repo.stopDesktopTunnelAttachment(
          owner,
          id,
          request.error,
          request.preserve,
          request.expected && {
            activatedAt:
              request.expected.activatedAt === null
                ? null
                : new Date(request.expected.activatedAt),
            expiresAt:
              request.expected.expiresAt === null
                ? null
                : new Date(request.expected.expiresAt),
            secretExpiresAt:
              request.expected.secretExpiresAt === null
                ? null
                : new Date(request.expected.secretExpiresAt),
          },
        );
      case "tunnel-direct-activate":
        return await repo.activateDesktopTunnelDirectLease(
          owner,
          id,
          request.capability,
          new Date(request.expires),
          new Date(request.secret),
        );
      case "tunnel-direct-renew":
        return await repo.renewDesktopTunnelDirectLease(
          owner,
          id,
          request.capability,
          new Date(request.expires),
        );
      case "tunnel-direct-finalize":
        return await repo.finalizeDesktopTunnelDirectLease(
          owner,
          id,
          request.capability,
          new Date(request.expires),
        );
      case "tunnel-direct-expire":
        return await repo.expireDesktopTunnelDirectLeases(
          new Date(request.at ?? now),
        );
      case "tunnel-attachment-expire":
        return await repo.expireDesktopTunnelAttachments(
          new Date(request.at ?? now),
        );
      case "tunnel-reset":
        await repo.resetTransientTunnelAttachments();
        return null;
      default:
        throw new Error("Unsupported tunnel fixture operation");
    }
  } finally {
    globalThis.Date = OriginalDate;
  }
}

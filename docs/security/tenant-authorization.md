# Tenant authorization boundary

Cantrip resolves one application owner for every authenticated request. In
`accounts` mode that owner is the signed-in account ID; in local and password
modes it is the stable local identity. Repository calls reachable from the
application API receive that owner explicitly. An accounts-mode operation
without an authenticated or explicitly delegated owner fails closed.

## Request and background context

Fastify establishes the request principal before route handlers execute. The
server carries its owner ID through asynchronous request work with
`AsyncLocalStorage`, which keeps deep helpers owner-scoped without relying on a
process-global current user. Trusted background entry points must explicitly
enter an owner context. Examples include a validated webhook delivery and each
candidate selected by the workflow schedule scanner.

Worker enrollment and service credentials are a separate machine-identity
boundary. Every hosted internal route resolves a hashed worker credential to
its owner, immutable worker ID, and required scope. Accounts mode never falls
back to the local user; the development token is accepted only for explicit
anonymous loopback pnpm-dev/Tauri bootstraps.

## HTTP enumeration resistance

Repository lookups include the owner alongside resource identifiers. A
foreign identifier therefore follows the same not-found path as a random
identifier. Collection routes return only owned rows. This applies to project
tabs, chat data, model/provider configuration, workflows, worktrees, remote
surfaces, and their mutations.

The public workflow webhook route is an intentional exception to cookie
authentication. It first resolves only webhook-capable trigger metadata,
compares the resource-bound credential without exposing trigger existence, and
then enters the trigger owner's context for delivery. Invalid trigger IDs and
invalid credentials both return `404`.

## Long-lived transports and capabilities

- Application live sockets bind to an owner and, when present, a user session.
  Subscriptions are re-authorized by owner. Events and replay cursors are
  private per owner, so even `current-user` invalidations cannot cross tenants.
- Logout closes live, terminal, and remote-surface sockets for the revoked
  session. Logout-all closes every tracked socket for the account. Active live
  sessions are revalidated during heartbeat maintenance, while terminal and
  remote-surface sessions are periodically revalidated.
- Cantrip Code attachment tokens are random, idle-expiring, maximum-lifetime
  bounded, and bound to owner, authenticated user session, worker, Code tab,
  editor session, managed tunnel, and relay attachment. The worker verifies the
  selected editor session still belongs to the tunnel's Code tab before it
  opens the loopback target. Revoking a login session invalidates its
  attachments.
- Project-share tokens remain explicit, revocable, expiring capabilities bound
  to owner, project, worker, and canonical filesystem root.

## Application session boundary

The app selects a server before it has access to account state. A server profile
stores only a human-readable name and HTTP(S) origin. Passwords, bootstrap
tokens, raw session tokens, and CSRF tokens are never written to browser
storage. The server session stays in its HttpOnly cookie and the current CSRF
token stays in application memory.

Bootstrap and `/api/auth/session` complete before React Query resources or the
application live socket mount. A server change performs a full application
reload, while account-owned local caches and live resume cursors include both
the server and user ID. HTTP `401` responses and policy-close live sockets
immediately unmount account state and return to sign-in. Hosted mode defaults
to `Secure; SameSite=None` cookies so approved browser, Tauri, and Capacitor
origins can authenticate cross-origin; origin validation and CSRF enforcement
remain mandatory for mutations.

## Verification

`pnpm audit:server-boundaries` checks the committed route/repository inventory.
Tenant integration tests use two simultaneous accounts to prove settings,
providers, projects, and project collections remain isolated and that foreign
IDs are indistinguishable from missing IDs. Live-hub tests separately prove
owner-private delivery/replay and session revocation. The same audit walks all
production server source to prohibit Task decryption dependencies, assigns an
opaque or plaintext-rejection contract to each Task-adjacent route, and checks
the repository guards that prevent ordinary plaintext messages, queued
prompts, and project automations from targeting Task-experience chats.

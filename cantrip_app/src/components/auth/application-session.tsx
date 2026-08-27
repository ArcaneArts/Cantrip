import type {
  AuthSession,
  ServerBootstrap,
  UserSummary,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import {
  AlertCircle,
  Loader2,
  LockKeyhole,
  Server,
  WandSparkles,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import { ApplicationLoadingSplash } from "@/components/auth/application-loading-splash";
import { DesktopWorkerRecoverySession } from "@/components/auth/desktop-worker-recovery-session";
import { MobileSignInScanner } from "@/components/auth/mobile-sign-in-scanner";
import { SessionWindowDragRegion } from "@/components/auth/session-window-drag-region";
import { WorkerObservationSession } from "@/components/auth/worker-observation-session";
import { AddServerForm } from "@/components/servers/add-server-form";
import { ServerSwitcher } from "@/components/servers/server-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getAuthSession,
  getServerBootstrap,
  login,
  registerAccount,
} from "@/lib/api";
import { CantripApiError } from "@/lib/api-client";
import { AppLiveClient, appLiveWebSocketUrl } from "@/lib/app-live-client";
import { AppLiveQueryBridge } from "@/lib/app-live-query";
import { AppLiveProvider } from "@/lib/app-live-react";
import { WorkerObservationClient } from "@/lib/worker-observation-client";
import {
  WorkerObservationBackgroundDemandSession,
  WorkerObservationProvider,
} from "@/lib/worker-observation-react";
import {
  authenticationRequiredAction,
  clearClientSession,
  notifyAuthenticationRequired,
  onAuthenticationRequired,
  setClientSession,
} from "@/lib/client-session";
import { errorMessage } from "@/lib/error-message";
import { prepareClientEncryption } from "@/lib/account-encryption";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import { isMacosDesktopRuntime } from "@/lib/desktop-popout";
import {
  getActiveServerConnection,
  rememberActiveServerAccount,
  selectServerConnection,
  type ServerConnectionFailureKind,
} from "@/lib/server-connections";
import { router } from "@/router";

type AuthenticatedSessionContext = {
  bootstrap: ServerBootstrap;
  csrfToken: string | null;
  expiresAt: string | null;
  user: UserSummary;
};

type ApplicationSessionState =
  | { kind: "loading" }
  | { kind: "server-required" }
  | {
      kind: "connection-error";
      failureKind: ServerConnectionFailureKind;
      message: string;
    }
  | {
      kind: "signed-out";
      bootstrap: ServerBootstrap;
      notice: string | null;
    }
  | ({ kind: "authenticated" } & AuthenticatedSessionContext)
  | ({
      kind: "encryption-error";
      message: string;
    } & AuthenticatedSessionContext);

function connectionFailure(
  error: unknown,
): Extract<ApplicationSessionState, { kind: "connection-error" }> {
  const message = errorMessage(error);
  const status =
    error && typeof error === "object" && "status" in error
      ? Number(error.status)
      : null;
  const failureKind: ServerConnectionFailureKind =
    status === 401 || status === 403
      ? "authentication"
      : status === 404 || status === 426
        ? "version"
        : (error instanceof Error && error.name === "ZodError") ||
            /protocol|parse|compatible|version/i.test(message)
          ? "compatibility"
          : /certificate|ssl|tls/i.test(message)
            ? "tls"
            : "network";
  return { kind: "connection-error", failureKind, message };
}

async function loadApplicationSession(): Promise<ApplicationSessionState> {
  const startedAt = performance.now();
  clientLogger.info("Loading the Cantrip application session", {
    event: "session.load.started",
    operation: "load-session",
    subsystem: "authentication",
  });
  if (!getActiveServerConnection()) {
    clearClientSession();
    clientLogger.info("Application session requires a server", {
      durationMs: Math.round(performance.now() - startedAt),
      event: "session.load.completed",
      operation: "load-session",
      status: "server-required",
      subsystem: "authentication",
    });
    return { kind: "server-required" };
  }
  let clearedConflictingSession = false;
  let bootstrap: ServerBootstrap;
  try {
    bootstrap = await getServerBootstrap();
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? Number(error.status)
        : null;
    if (status !== 401) throw error;
    clearedConflictingSession = true;
    bootstrap = await getServerBootstrap();
  }
  if (bootstrap.auth.mode === "none") {
    if (!bootstrap.auth.currentUser) {
      throw new Error("The local server did not provide its anonymous user.");
    }
    const state: ApplicationSessionState = {
      kind: "authenticated",
      bootstrap,
      csrfToken: null,
      expiresAt: null,
      user: bootstrap.auth.currentUser,
    };
    clientLogger.info("Anonymous application session is ready", {
      durationMs: Math.round(performance.now() - startedAt),
      event: "session.load.completed",
      operation: "load-session",
      serverId: bootstrap.server.id,
      status: "authenticated",
      subsystem: "authentication",
    });
    return state;
  }
  if (clearedConflictingSession) {
    clearClientSession();
    return {
      kind: "signed-out",
      bootstrap,
      notice: "A stale or conflicting session was cleared. Sign in again.",
    };
  }
  let session: Awaited<ReturnType<typeof getAuthSession>>;
  try {
    session = await getAuthSession();
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? Number(error.status)
        : null;
    if (status === 401) {
      clearClientSession();
      return {
        kind: "signed-out",
        bootstrap,
        notice: "A stale or conflicting session was cleared. Sign in again.",
      };
    }
    throw error;
  }
  if (!session.currentUser || !session.csrfToken) {
    clearClientSession();
    clientLogger.info("Application session requires sign-in", {
      durationMs: Math.round(performance.now() - startedAt),
      event: "session.load.completed",
      operation: "load-session",
      serverId: bootstrap.server.id,
      status: "signed-out",
      subsystem: "authentication",
    });
    return { kind: "signed-out", bootstrap, notice: null };
  }
  if (!(await rememberActiveServerAccount(session.currentUser.id))) {
    clearClientSession();
    return {
      kind: "signed-out",
      bootstrap,
      notice:
        "Another window pinned this server to a different account. Sign in again.",
    };
  }
  const state: ApplicationSessionState = {
    kind: "authenticated",
    bootstrap,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
    user: session.currentUser,
  };
  clientLogger.info("Authenticated application session is ready", {
    durationMs: Math.round(performance.now() - startedAt),
    event: "session.load.completed",
    operation: "load-session",
    serverId: bootstrap.server.id,
    status: "authenticated",
    subsystem: "authentication",
  });
  return state;
}

function sessionState(
  bootstrap: ServerBootstrap,
  session: AuthSession,
): Extract<ApplicationSessionState, { kind: "authenticated" }> {
  return {
    kind: "authenticated",
    bootstrap,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
    user: session.currentUser,
  };
}

async function encryptionSessionState(
  context: AuthenticatedSessionContext,
  password?: string,
): Promise<ApplicationSessionState> {
  setClientSession({
    authMode: context.bootstrap.auth.mode,
    csrfToken: context.csrfToken,
    expiresAt: context.expiresAt,
    serverId: context.bootstrap.server.id,
    user: context.user,
  });
  const access = await prepareClientEncryption({
    authMode: context.bootstrap.auth.mode,
    identity: {
      ownerId: context.user.id,
      serverId: context.bootstrap.server.id,
    },
    password,
  });
  if (access.status === "ready") {
    return { kind: "authenticated", ...context };
  }
  clearClientSession();
  return {
    kind: "signed-out",
    bootstrap: context.bootstrap,
    notice:
      access.reason === "initialize"
        ? "Sign in again once to finish setting up private data encryption."
        : "Sign in again once to authorize this device for private data.",
  };
}

function SessionFrame({ children }: { children: React.ReactNode }) {
  const active = getActiveServerConnection();
  return (
    <>
      <SessionWindowDragRegion enabled={isMacosDesktopRuntime()} />
      <main className="grid min-h-dvh place-items-center bg-background px-4 py-10 text-foreground">
        <section className="w-full max-w-md space-y-6">
          <header className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl border bg-card">
              <WandSparkles className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-base font-semibold">Cantrip</span>
              <span className="block truncate text-xs text-muted-foreground">
                {active
                  ? `${active.name} · ${active.url || "Local development server"}`
                  : "Remote server required"}
              </span>
            </span>
          </header>
          {children}
        </section>
      </main>
    </>
  );
}

function ServerSetupScreen({ onConnected }: { onConnected(): void }) {
  return (
    <SessionFrame>
      <div className="space-y-6 rounded-2xl border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
            <Server className="size-4" />
          </span>
          <div>
            <h1 className="font-semibold">Connect to a Cantrip server</h1>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Browser and mobile apps are clients only. Add the address of a
              Cantrip Server running on another device to continue.
            </p>
          </div>
        </div>
        <AddServerForm
          autoFocus
          onSaved={async (connection) => {
            await selectServerConnection(connection.id);
            clearClientSession();
            onConnected();
          }}
          submitLabel="Save and connect"
        />
      </div>
      <p className="text-center text-xs leading-5 text-muted-foreground">
        Enter the server origin, such as https://cantrip.example, without an API
        path.
      </p>
    </SessionFrame>
  );
}

function ConnectionErrorScreen({
  failureKind,
  message,
  onRetry,
}: {
  failureKind: ServerConnectionFailureKind;
  message: string;
  onRetry(): void;
}) {
  const label =
    failureKind === "tls"
      ? "Secure connection failed"
      : failureKind === "compatibility" || failureKind === "version"
        ? "Incompatible server"
        : failureKind === "authentication"
          ? "Authentication failed"
          : "Server unavailable";
  return (
    <SessionFrame>
      <div className="space-y-5 rounded-2xl border bg-card p-6">
        <div className="flex gap-3">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <h1 className="font-semibold">{label}</h1>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {message}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onRetry}>Try again</Button>
          <div className="min-w-0 flex-1">
            <ServerSwitcher
              currentUserName="Choose another server"
              workerName="Connection unavailable"
            />
          </div>
        </div>
        <MobileSignInScanner className="w-full" />
      </div>
    </SessionFrame>
  );
}

function AuthenticationScreen({
  bootstrap,
  notice,
  onAuthenticated,
}: {
  bootstrap: ServerBootstrap;
  notice: string | null;
  onAuthenticated(session: AuthSession, password: string): Promise<void>;
}) {
  const accounts = bootstrap.auth.mode === "accounts";
  const canRegister = accounts && bootstrap.auth.registration.enabled;
  const [registering, setRegistering] = useState(
    canRegister && bootstrap.auth.registration.bootstrapRequired,
  );
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (registering && password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    const startedAt = performance.now();
    clientLogger.info(
      registering ? "Account registration started" : "Sign-in started",
      {
        event: registering
          ? "session.registration.started"
          : "session.login.started",
        operation: registering ? "register" : "login",
        subsystem: "authentication",
      },
    );
    try {
      const session = registering
        ? await registerAccount(
            { displayName, email, password },
            bootstrap.auth.registration.bootstrapRequired
              ? bootstrapToken
              : undefined,
          )
        : await login({
            ...(accounts ? { email } : {}),
            password,
          });
      clientLogger.info(
        registering ? "Account registration completed" : "Sign-in completed",
        {
          durationMs: Math.round(performance.now() - startedAt),
          event: registering
            ? "session.registration.completed"
            : "session.login.completed",
          operation: registering ? "register" : "login",
          status: "authenticated",
          subsystem: "authentication",
        },
      );
      await onAuthenticated(session, password);
      setPassword("");
      setConfirmation("");
    } catch (submitError) {
      clientLogger.warn(
        registering ? "Account registration failed" : "Sign-in failed",
        {
          durationMs: Math.round(performance.now() - startedAt),
          ...operationalErrorMetadata(submitError),
          event: registering
            ? "session.registration.failed"
            : "session.login.failed",
          operation: registering ? "register" : "login",
          reasonCode: "request-failed",
          status: "failed",
          subsystem: "authentication",
        },
      );
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SessionFrame>
      <div className="rounded-2xl border bg-card p-6 shadow-sm">
        <div className="mb-6 flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
            <LockKeyhole className="size-4" />
          </span>
          <div>
            <h1 className="font-semibold">
              {registering
                ? "Create the first Cantrip account"
                : accounts
                  ? "Sign in to Cantrip"
                  : "Unlock this Cantrip server"}
            </h1>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {accounts
                ? bootstrap.auth.registration.licenseRequired && registering
                  ? "Your email must be licensed by this server's administrator before you can create an account."
                  : "Your projects, agents, and workers remain isolated on this server."
                : "Enter the password configured by this server's operator."}
            </p>
          </div>
        </div>

        {notice ? (
          <p className="mb-4 rounded-lg bg-muted px-3 py-2 text-sm">{notice}</p>
        ) : null}

        <form className="space-y-4" onSubmit={submit}>
          {registering ? (
            <label className="grid gap-1.5 text-sm">
              Display name
              <Input
                autoComplete="name"
                autoFocus
                onChange={(event) => setDisplayName(event.target.value)}
                required
                value={displayName}
              />
            </label>
          ) : null}
          {accounts ? (
            <label className="grid gap-1.5 text-sm">
              Email
              <Input
                autoComplete="email"
                autoFocus={!registering}
                inputMode="email"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </label>
          ) : null}
          <label className="grid gap-1.5 text-sm">
            Password
            <Input
              autoComplete={registering ? "new-password" : "current-password"}
              autoFocus={!accounts}
              minLength={registering ? 12 : undefined}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {registering ? (
            <label className="grid gap-1.5 text-sm">
              Confirm password
              <Input
                autoComplete="new-password"
                minLength={12}
                onChange={(event) => setConfirmation(event.target.value)}
                required
                type="password"
                value={confirmation}
              />
            </label>
          ) : null}
          {registering && bootstrap.auth.registration.bootstrapRequired ? (
            <label className="grid gap-1.5 text-sm">
              First-admin bootstrap token
              <Input
                autoComplete="off"
                onChange={(event) => setBootstrapToken(event.target.value)}
                required
                type="password"
                value={bootstrapToken}
              />
            </label>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button className="w-full" disabled={submitting} type="submit">
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {registering ? "Create account" : "Continue"}
          </Button>
        </form>

        {!registering ? <MobileSignInScanner className="mt-3 w-full" /> : null}

        <div className="mt-4 flex items-center justify-between gap-3 text-xs">
          {canRegister && !bootstrap.auth.registration.bootstrapRequired ? (
            <button
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setError(null);
                setRegistering((value) => !value);
              }}
              type="button"
            >
              {registering ? "Use an existing account" : "Create an account"}
            </button>
          ) : (
            <span />
          )}
          <div className="min-w-0 max-w-52">
            <ServerSwitcher
              currentUserName="Switch server"
              workerName="Sign-in required"
            />
          </div>
        </div>
      </div>
      <p className="flex items-center justify-center gap-2 text-center text-xs text-muted-foreground">
        <Server className="size-3.5" /> Passwords and session credentials are
        never saved by the app.
      </p>
    </SessionFrame>
  );
}

function EncryptionErrorScreen({
  message,
  onRetry,
}: Extract<ApplicationSessionState, { kind: "encryption-error" }> & {
  onRetry(): void;
}) {
  return (
    <SessionFrame>
      <div className="space-y-5 rounded-2xl border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div>
            <h1 className="font-semibold">Private data is locked</h1>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {message}
            </p>
          </div>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          Cantrip will not open the application or write protected data while
          encryption is unavailable.
        </p>
        <div className="flex items-center gap-2">
          <Button onClick={onRetry}>Try again</Button>
          <div className="min-w-0 flex-1">
            <ServerSwitcher
              currentUserName="Switch server"
              workerName="Encryption unavailable"
            />
          </div>
        </div>
      </div>
    </SessionFrame>
  );
}

function AuthenticatedApplication({
  bootstrap,
  user,
}: {
  bootstrap: ServerBootstrap;
  user: UserSummary;
}) {
  const serverUrl = getActiveServerConnection()?.url ?? "";
  const queryClient = useMemo(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          refetchOnWindowFocus: false,
          retry: (failureCount, error) =>
            !(
              error instanceof CantripApiError &&
              [429, 503].includes(error.status)
            ) && failureCount < 3,
        },
      },
    });
    client.setQueryData(["server-bootstrap"], bootstrap);
    return client;
  }, [bootstrap.server.id, user.id]);
  const queryBridge = useMemo(
    () => new AppLiveQueryBridge(queryClient),
    [queryClient],
  );
  const liveClient = useMemo(() => {
    const clientIdKey = "cantrip.app-live.client-id.v1";
    let clientId = window.localStorage.getItem(clientIdKey);
    if (!clientId) {
      clientId = crypto.randomUUID();
      window.localStorage.setItem(clientIdKey, clientId);
    }
    return new AppLiveClient({
      client: {
        id: clientId,
        name: "Cantrip App",
        version: "0.0.0",
        controlCapabilities: [
          "notify",
          "focus-project",
          "focus-surface",
          "show-interaction",
        ],
      },
      onAuthenticationRequired: notifyAuthenticationRequired,
      onEvent: (event) => queryBridge.handleEvent(event),
      onProtocolError: (error) => {
        clientLogger.error("Cantrip live protocol handler reported an error", {
          event: "live.channel.protocol-handler-error",
          operation: "handle-protocol-error",
          reasonCode: error.code,
          retryable: error.retryable,
          status: "failed",
          subsystem: "live-channel",
        });
      },
      onResync: (scopes, reason) => queryBridge.recoverScopes(scopes, reason),
      storage: window.localStorage,
      storageKey: `cantrip.app-live.resume.v1.${bootstrap.server.id}.${user.id}`,
      url: appLiveWebSocketUrl(serverUrl, window.location.origin),
    });
  }, [bootstrap.server.id, queryBridge, serverUrl, user.id]);
  const observationClient = useMemo(
    () => new WorkerObservationClient(queryBridge),
    [queryBridge],
  );

  useEffect(() => {
    const releaseScope = liveClient.retainScope({ kind: "current-user" });
    liveClient.start();
    const reconnect = () => liveClient.reconnectNow();
    const flushLiveCursor = () => liveClient.flushCursorPersistence();
    const flushLiveCursorWhenHidden = () => {
      if (document.visibilityState === "hidden") flushLiveCursor();
    };
    window.addEventListener("online", reconnect);
    window.addEventListener("pagehide", flushLiveCursor);
    document.addEventListener("visibilitychange", flushLiveCursorWhenHidden);
    return () => {
      window.removeEventListener("online", reconnect);
      window.removeEventListener("pagehide", flushLiveCursor);
      document.removeEventListener(
        "visibilitychange",
        flushLiveCursorWhenHidden,
      );
      releaseScope();
      liveClient.stop();
      queryClient.clear();
    };
  }, [liveClient, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <AppLiveProvider client={liveClient}>
        <WorkerObservationProvider client={observationClient}>
          <WorkerObservationSession client={observationClient} />
          <WorkerObservationBackgroundDemandSession />
          <DesktopWorkerRecoverySession />
          <RouterProvider router={router} />
        </WorkerObservationProvider>
      </AppLiveProvider>
    </QueryClientProvider>
  );
}

export function ApplicationSession() {
  const [state, setState] = useState<ApplicationSessionState>({
    kind: "loading",
  });

  const refresh = useCallback(() => {
    const startedAt = performance.now();
    setState({ kind: "loading" });
    void (async () => {
      try {
        let next = await loadApplicationSession();
        if (next.kind === "authenticated") {
          const context: AuthenticatedSessionContext = next;
          try {
            next = await encryptionSessionState(context);
          } catch (error) {
            clientLogger.warn("Client encryption session preparation failed", {
              durationMs: Math.round(performance.now() - startedAt),
              ...operationalErrorMetadata(error),
              event: "encryption.session.prepare.failed",
              operation: "prepare-encryption",
              reasonCode: "encryption-unavailable",
              status: "locked",
              subsystem: "encryption",
            });
            next = {
              ...context,
              kind: "encryption-error",
              message: errorMessage(error),
            };
          }
        }
        clientLogger.info("Application session refresh completed", {
          durationMs: Math.round(performance.now() - startedAt),
          event: "session.refresh.completed",
          operation: "refresh-session",
          status: next.kind,
          subsystem: "authentication",
        });
        setState(next);
      } catch (error) {
        const failure = connectionFailure(error);
        clientLogger.warn("Application session refresh failed", {
          durationMs: Math.round(performance.now() - startedAt),
          ...operationalErrorMetadata(error),
          event: "session.refresh.failed",
          operation: "refresh-session",
          reasonCode: failure.failureKind,
          status: "failed",
          subsystem: "authentication",
        });
        setState(failure);
      }
    })();
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    if (state.kind !== "connection-error") return;
    window.addEventListener("online", refresh);
    return () => window.removeEventListener("online", refresh);
  }, [refresh, state.kind]);
  useEffect(
    () =>
      onAuthenticationRequired((reason) => {
        if (authenticationRequiredAction() === "refresh-encryption") {
          clientLogger.warn(
            "Local encryption authorization is required again",
            {
              event: "encryption.session.authorization-required",
              operation: "recover-encryption-session",
              reasonCode: "local-device-authorization-required",
              status: "refreshing",
              subsystem: "encryption",
            },
          );
          refresh();
          return;
        }
        clientLogger.warn("Application session expired", {
          event: "session.expired",
          operation: "recover-session",
          reasonCode: "authentication-required",
          status: "signed-out",
          subsystem: "authentication",
        });
        clearClientSession();
        setState((current) => {
          if (
            (current.kind === "authenticated" ||
              current.kind === "encryption-error") &&
            current.bootstrap.auth.mode !== "none"
          ) {
            return {
              kind: "signed-out",
              bootstrap: current.bootstrap,
              notice: reason,
            };
          }
          return current;
        });
      }),
    [refresh],
  );
  if (state.kind === "loading") {
    return <ApplicationLoadingSplash />;
  }
  if (state.kind === "connection-error") {
    return <ConnectionErrorScreen {...state} onRetry={refresh} />;
  }
  if (state.kind === "server-required") {
    return <ServerSetupScreen onConnected={refresh} />;
  }
  if (state.kind === "signed-out") {
    return (
      <AuthenticationScreen
        bootstrap={state.bootstrap}
        notice={state.notice}
        onAuthenticated={async (session, password) => {
          await rememberActiveServerAccount(session.currentUser.id, true);
          const context: AuthenticatedSessionContext = sessionState(
            state.bootstrap,
            session,
          );
          try {
            setState(await encryptionSessionState(context, password));
          } catch (encryptionError) {
            setState({
              ...context,
              kind: "encryption-error",
              message: errorMessage(encryptionError),
            });
          }
        }}
      />
    );
  }
  if (state.kind === "encryption-error") {
    return (
      <EncryptionErrorScreen
        {...state}
        onRetry={() => {
          void encryptionSessionState(state).then(setState, (retryError) =>
            setState({
              ...state,
              message: errorMessage(retryError),
            }),
          );
        }}
      />
    );
  }
  return (
    <AuthenticatedApplication bootstrap={state.bootstrap} user={state.user} />
  );
}

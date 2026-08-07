import { useQuery } from "@tanstack/react-query";
import {
  Cloud,
  Database,
  Laptop,
  RefreshCw,
  Route,
  Server,
  ShieldCheck,
  Sparkles,
  WandSparkles,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getServerBootstrap, getSystemHealth, getWorkers } from "@/lib/api";
import { cn } from "@/lib/utils";

const surfaces = [
  {
    description: "Vite, React, Tailwind, shadcn/ui, Tauri, and Capacitor.",
    icon: Laptop,
    name: "cantrip_app",
  },
  {
    description: "Fastify API with embedded PGlite or external PostgreSQL.",
    icon: Server,
    name: "cantrip_server",
  },
  {
    description: "Outbound machine agent ready to supervise Codex app-server.",
    icon: Cloud,
    name: "cantrip_worker",
  },
] as const;

function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      className={cn(
        "size-2 rounded-full",
        online
          ? "bg-emerald-500 shadow-[0_0_12px_#10b981]"
          : "bg-muted-foreground/40",
      )}
    />
  );
}

export function App() {
  const bootstrap = useQuery({
    queryFn: getServerBootstrap,
    queryKey: ["server-bootstrap"],
    retry: true,
  });
  const health = useQuery({
    queryFn: getSystemHealth,
    queryKey: ["system-health"],
    refetchInterval: 3_000,
    retry: true,
  });
  const workers = useQuery({
    queryFn: getWorkers,
    queryKey: ["workers"],
    refetchInterval: 3_000,
    retry: true,
  });
  const serverOnline = bootstrap.isSuccess && health.isSuccess;

  return (
    <main className="min-h-svh bg-background text-foreground">
      <div className="mx-auto flex min-h-svh max-w-6xl flex-col px-5 py-6 sm:px-8 lg:px-10">
        <header className="flex items-center justify-between border-b pb-5">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl border bg-card shadow-sm">
              <WandSparkles className="size-5" aria-hidden="true" />
            </div>
            <div>
              <p className="font-semibold tracking-tight">Cantrip</p>
              <p className="text-xs text-muted-foreground">cantrip.art</p>
            </div>
          </div>
          <Badge variant="outline" className="gap-2 px-3 py-1.5">
            <StatusDot online={serverOnline} />
            {serverOnline ? "Local stack online" : "Connecting"}
          </Badge>
        </header>

        <section className="grid flex-1 items-center gap-10 py-12 lg:grid-cols-[1.15fr_0.85fr] lg:py-20">
          <div className="max-w-2xl">
            <Badge variant="secondary" className="mb-5 gap-1.5">
              <Sparkles className="size-3" aria-hidden="true" />
              Foundation workspace
            </Badge>
            <h1 className="text-balance text-4xl font-semibold tracking-[-0.04em] sm:text-5xl lg:text-6xl">
              Your coding agents, wherever the work lives.
            </h1>
            <p className="mt-5 max-w-xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg">
              The Cantrip app, server, and worker now share one pnpm workspace
              and one local development lifecycle. This screen is the first live
              contract between all three.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button
                onClick={() => {
                  void Promise.all([
                    bootstrap.refetch(),
                    health.refetch(),
                    workers.refetch(),
                  ]);
                }}
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                Refresh status
              </Button>
              <Button asChild variant="outline">
                <a href="https://cantrip.art">cantrip.art</a>
              </Button>
            </div>
          </div>

          <Card className="overflow-hidden bg-card/80 backdrop-blur">
            <CardHeader className="border-b pb-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <CardTitle>Server authority</CardTitle>
                  <CardDescription className="mt-1.5">
                    Configuration announced by cantrip_server
                  </CardDescription>
                </div>
                <Database
                  className="size-5 text-muted-foreground"
                  aria-hidden="true"
                />
              </div>
            </CardHeader>
            <CardContent className="grid gap-5 pt-1">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border bg-background/60 p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Database
                  </p>
                  <p className="mt-2 font-medium capitalize">
                    {health.data?.database.engine ?? "Waiting"}
                  </p>
                </div>
                <div className="rounded-lg border bg-background/60 p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Workers
                  </p>
                  <p className="mt-2 font-medium">
                    {health.data?.workers.connected ?? 0} connected
                  </p>
                </div>
                <div className="rounded-lg border bg-background/60 p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Identity
                  </p>
                  <p className="mt-2 font-medium capitalize">
                    {bootstrap.data?.auth.mode === "none"
                      ? "Anonymous local"
                      : (bootstrap.data?.auth.mode ?? "Waiting")}
                  </p>
                </div>
                <div className="rounded-lg border bg-background/60 p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Deployment
                  </p>
                  <p className="mt-2 font-medium capitalize">
                    {bootstrap.data?.server.deploymentMode ?? "Waiting"}
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex gap-3 rounded-lg border p-4">
                  <Route
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div>
                    <p className="text-sm font-medium">Server-only routing</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Apps never connect directly to workers.
                    </p>
                  </div>
                </div>
                <div className="flex gap-3 rounded-lg border p-4">
                  <ShieldCheck
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div>
                    <p className="text-sm font-medium">Split ownership</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Chats live here; files stay on the worker.
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                {(workers.data ?? []).map((worker) => (
                  <div
                    key={worker.workerId}
                    className="flex items-center justify-between gap-4 rounded-lg border p-4"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <StatusDot online={worker.online} />
                        <p className="truncate text-sm font-medium">
                          {worker.name}
                        </p>
                      </div>
                      <p className="mt-1 truncate pl-4 text-xs text-muted-foreground">
                        {worker.codexVersion ?? "Codex CLI not detected"}
                      </p>
                    </div>
                    <Badge variant="secondary">
                      {worker.platform}/{worker.architecture}
                    </Badge>
                  </div>
                ))}

                {workers.data?.length === 0 ? (
                  <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    Waiting for the local worker heartbeat.
                  </p>
                ) : null}

                {health.isError ? (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                    The Vite app is running, but cantrip_server is not reachable
                    yet.
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-3 border-t py-6 md:grid-cols-3">
          {surfaces.map(({ description, icon: Icon, name }) => (
            <div key={name} className="flex gap-3 rounded-lg p-3">
              <Icon
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div>
                <p className="font-mono text-xs font-medium">{name}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {description}
                </p>
              </div>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}

import { terminalServerMessageSchema } from "@cantrip/protocol";
import {
  terminalInputContentSchema,
  terminalOutputContentSchema,
} from "@cantrip/protocol/surface-stream";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { installTerminalLinkLayer } from "@/components/terminal/terminal-link-layer";
import { refreshWorkerEncryption } from "@/lib/api/worker-wire";
import { clientEncryption } from "@/lib/client-encryption";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
} from "@/lib/client-session";
import { openExternalUrl } from "@/lib/external-url";
import { getActiveServerUrl } from "@/lib/server-connections";
import {
  openSurfaceStreamContent,
  protectSurfaceStreamContent,
} from "@/lib/surface-stream-encryption";
import { authorizeWorkerEncryption } from "@/lib/worker-encryption-grants";

import "@xterm/xterm/css/xterm.css";

export function ClaudeCodeLoginTerminal({
  providerId,
  accountId,
  workerId,
  onSignedIn,
}: {
  providerId: string;
  accountId: string;
  workerId: string;
  onSignedIn(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState("Starting Claude Code on the worker…");
  const [failed, setFailed] = useState(false);
  const signedIn = useEffectEvent(onSignedIn);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let complete = false;
    let ready = false;
    let socket: WebSocket | undefined;
    let inputSequence = 0;
    let outputSequence = 0;
    let input = Promise.resolve();
    let output = Promise.resolve();
    const operationId = crypto.randomUUID();
    const identity = getClientSessionIdentitySnapshot();
    const binding = {
      operationId,
      surfaceKind: "terminal" as const,
      surfaceId: `claude-login:${operationId}`,
    };
    const styles = getComputedStyle(document.documentElement);
    const terminal = new Terminal({
      scrollback: 500,
      fontSize: 12,
      cursorBlink: true,
      theme: {
        background: styles.getPropertyValue("--background").trim(),
        foreground: styles.getPropertyValue("--foreground").trim(),
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);

    const ensureIdentity = () => {
      if (!identity || !clientSessionIdentityMatches(identity)) {
        throw new Error("The Cantrip account or server changed.");
      }
    };
    const fail = (cause: unknown) => {
      if (disposed || complete) return;
      complete = true;
      socket?.close();
      setFailed(true);
      setNotice(
        cause instanceof Error ? cause.message : "Claude Code sign-in failed.",
      );
    };
    const openLoginLink = (value: string) => {
      const url = new URL(value);
      if (
        url.protocol === "https:" &&
        (url.hostname === "claude.ai" ||
          url.hostname.endsWith(".claude.ai") ||
          url.hostname === "claude.com" ||
          url.hostname.endsWith(".claude.com") ||
          url.hostname === "anthropic.com" ||
          url.hostname.endsWith(".anthropic.com"))
      ) {
        void openExternalUrl(value).catch(() =>
          setNotice(
            "Copy the sign-in link from the terminal into your browser.",
          ),
        );
      }
    };
    const links = installTerminalLinkLayer({
      terminal,
      onOpen: openLoginLink,
      onOpenExternal: openLoginLink,
    });
    const sendDimensions = () => {
      fit.fit();
      if (ready && !complete && socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      }
    };
    const sizes = new ResizeObserver(sendDimensions);
    sizes.observe(element);

    const keys = terminal.onData((data) => {
      if (!ready || complete) return;
      input = input
        .then(async () => {
          if (disposed || complete) return;
          ensureIdentity();
          const sequence = inputSequence++;
          const protectedData = await protectSurfaceStreamContent({
            context: { ...binding, direction: "input", sequence },
            schema: terminalInputContentSchema,
            content: { type: "terminal.input", data },
          });
          ensureIdentity();
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(
              JSON.stringify({
                type: "input",
                operationId,
                sequence,
                protectedData,
              }),
            );
          }
        })
        .catch(fail);
    });

    async function connect() {
      const encryption = clientEncryption.getSnapshot();
      if (
        !identity ||
        encryption.status !== "ready" ||
        !encryption.identity ||
        !encryption.masterKeyRevision ||
        encryption.identity.ownerId !== identity.userId ||
        encryption.identity.serverId !== identity.serverId
      ) {
        throw new Error("Unlock Cantrip encryption before signing in.");
      }
      await authorizeWorkerEncryption({
        assertCurrent: ensureIdentity,
        components: ["surface-private-state"],
        identity: encryption.identity,
        keyRevision: encryption.masterKeyRevision,
        workerId,
      });
      if (disposed) return;
      await refreshWorkerEncryption(workerId, {
        component: "surface-private-state",
        keyRevision: encryption.masterKeyRevision,
      });
      if (disposed) return;
      ensureIdentity();
      const origin = getActiveServerUrl() || window.location.origin;
      const url = new URL(
        `/api/settings/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}/claude-login/connect`,
        origin,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("operationId", operationId);
      socket = new WebSocket(url);
      socket.onmessage = (event) => {
        output = output
          .then(async () => {
            if (disposed || complete) return;
            ensureIdentity();
            const message = terminalServerMessageSchema.parse(
              JSON.parse(event.data),
            );
            switch (message.type) {
              case "ready":
                ready = true;
                sendDimensions();
                terminal.focus();
                setNotice("Follow the sign-in instructions in the terminal.");
                break;
              case "output": {
                if (
                  message.operationId !== operationId ||
                  message.sequence !== outputSequence++
                ) {
                  throw new Error(
                    "The Claude Code terminal output was interrupted.",
                  );
                }
                const content = await openSurfaceStreamContent({
                  context: {
                    ...binding,
                    direction: "output",
                    sequence: message.sequence,
                  },
                  opaque: message.protectedData,
                  schema: terminalOutputContentSchema,
                });
                if (!disposed)
                  terminal.write(content.data, () => links.refresh());
                break;
              }
              case "exit":
                if (
                  message.exitCode === 0 &&
                  (!message.executionOutcome ||
                    message.executionOutcome === "exited")
                ) {
                  complete = true;
                  socket?.close();
                  signedIn();
                } else {
                  throw new Error(
                    "Claude Code sign-in did not complete. Check the terminal and try again.",
                  );
                }
                break;
              case "error":
                throw new Error(message.message);
            }
          })
          .catch(fail);
      };
      socket.onclose = () => {
        void output.then(() =>
          fail(
            new Error(
              "The sign-in connection closed. Reconnect the worker and try again.",
            ),
          ),
        );
      };
    }
    void connect().catch(fail);
    return () => {
      disposed = true;
      socket?.close();
      keys.dispose();
      links.dispose();
      sizes.disconnect();
      terminal.dispose();
    };
  }, [accountId, providerId, workerId]);

  return (
    <div className="min-w-0 space-y-2">
      <p
        role={failed ? "alert" : "status"}
        className={
          failed ? "text-sm text-destructive" : "text-sm text-muted-foreground"
        }
      >
        {notice}
      </p>
      <div
        aria-label="Claude Code sign-in terminal"
        ref={host}
        className="h-64 min-w-0 overflow-hidden rounded border bg-background p-2"
      />
    </div>
  );
}

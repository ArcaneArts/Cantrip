import type {
  AgentInteractionRequest,
  AgentInteractionResponse,
} from "@cantrip/protocol";
import {
  CircleAlert,
  ExternalLink,
  FilePenLine,
  KeyRound,
  Loader2,
  MessageCircleQuestion,
  PlugZap,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

type InteractionPayload = AgentInteractionRequest["payload"];

function displayJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function buildUserInputResponse(
  payload: Extract<InteractionPayload, { kind: "userInput" }>,
  values: Record<string, string>,
  otherValues: Record<string, string>,
): AgentInteractionResponse | null {
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of payload.questions) {
    const selected = values[question.id]?.trim();
    const answer =
      selected === "__other__" ? otherValues[question.id]?.trim() : selected;
    if (!answer) return null;
    answers[question.id] = { answers: [answer] };
  }
  return { kind: "userInput", answers };
}

export function commandDecisionResponse(
  payload: Extract<InteractionPayload, { kind: "commandExecution" }>,
  decision: Extract<
    AgentInteractionResponse,
    { kind: "commandExecution" }
  >["decision"],
): AgentInteractionResponse {
  return {
    kind: "commandExecution",
    decision,
    execpolicyAmendment:
      decision === "acceptWithExecpolicyAmendment"
        ? payload.proposedExecpolicyAmendment
        : null,
    networkPolicyAmendment:
      decision === "applyNetworkPolicyAmendment"
        ? (payload.proposedNetworkPolicyAmendments?.[0] ?? null)
        : null,
  };
}

const COMMAND_LABELS: Record<
  Extract<AgentInteractionResponse, { kind: "commandExecution" }>["decision"],
  string
> = {
  accept: "Allow once",
  acceptForSession: "Allow for session",
  acceptWithExecpolicyAmendment: "Allow command rule",
  applyNetworkPolicyAmendment: "Allow network rule",
  decline: "Deny",
  cancel: "Cancel turn",
};

function UserInputCard({
  disabled,
  onRespond,
  request,
}: CardProps & {
  request: AgentInteractionRequest & {
    payload: Extract<InteractionPayload, { kind: "userInput" }>;
  };
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [otherValues, setOtherValues] = useState<Record<string, string>>({});
  useEffect(() => {
    setValues({});
    setOtherValues({});
  }, [request.id]);
  const response = buildUserInputResponse(request.payload, values, otherValues);
  return (
    <InteractionCard
      icon={MessageCircleQuestion}
      title="Codex needs your input"
      description="The turn is paused until every question is answered."
    >
      <div className="space-y-3">
        {request.payload.questions.map((question) => (
          <fieldset key={question.id} className="space-y-2">
            <legend className="text-sm font-medium">
              <span className="mr-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                {question.header}
              </span>
              {question.question}
            </legend>
            {question.options ? (
              <div className="space-y-1.5">
                {question.options.map((option) => (
                  <label
                    key={option.label}
                    className="flex cursor-pointer items-start gap-2 rounded-md border bg-background/70 px-3 py-2 text-sm"
                  >
                    <input
                      type="radio"
                      name={`${request.id}:${question.id}`}
                      checked={values[question.id] === option.label}
                      onChange={() =>
                        setValues((current) => ({
                          ...current,
                          [question.id]: option.label,
                        }))
                      }
                      className="mt-1"
                    />
                    <span>
                      <span className="block font-medium">{option.label}</span>
                      {option.description ? (
                        <span className="block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
                {question.isOther ? (
                  <label className="flex items-center gap-2 rounded-md border bg-background/70 px-3 py-2 text-sm">
                    <input
                      type="radio"
                      name={`${request.id}:${question.id}`}
                      checked={values[question.id] === "__other__"}
                      onChange={() =>
                        setValues((current) => ({
                          ...current,
                          [question.id]: "__other__",
                        }))
                      }
                    />
                    <input
                      type={question.isSecret ? "password" : "text"}
                      value={otherValues[question.id] ?? ""}
                      aria-label={`Other answer for ${question.header}`}
                      autoComplete="off"
                      onFocus={() =>
                        setValues((current) => ({
                          ...current,
                          [question.id]: "__other__",
                        }))
                      }
                      onChange={(event) =>
                        setOtherValues((current) => ({
                          ...current,
                          [question.id]: event.target.value,
                        }))
                      }
                      className="h-7 min-w-0 flex-1 bg-transparent outline-none"
                      placeholder="Other"
                    />
                  </label>
                ) : null}
              </div>
            ) : (
              <input
                type={question.isSecret ? "password" : "text"}
                value={values[question.id] ?? ""}
                aria-label={question.header}
                autoComplete="off"
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [question.id]: event.target.value,
                  }))
                }
                className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            )}
          </fieldset>
        ))}
      </div>
      <Button
        type="button"
        size="sm"
        disabled={disabled || !response}
        onClick={() => response && onRespond(request.id, response)}
      >
        {disabled ? <Loader2 className="size-3.5 animate-spin" /> : null}
        Send answer
      </Button>
    </InteractionCard>
  );
}

type CardProps = {
  disabled: boolean;
  onRespond(requestId: string, response: AgentInteractionResponse): void;
};

function InteractionCard({
  children,
  description,
  icon: Icon,
  title,
}: {
  children: ReactNode;
  description: string;
  icon: typeof CircleAlert;
  title: string;
}) {
  return (
    <section
      data-slot="agent-interaction-card"
      className="rounded-xl border border-amber-500/30 bg-[var(--popover-solid)] p-3 text-popover-foreground shadow-lg"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            {title}
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {description}
          </p>
          <div className="mt-3 space-y-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

function InteractionRequestCard({
  disabled,
  onRespond,
  request,
}: CardProps & { request: AgentInteractionRequest }) {
  const payload = request.payload;
  const [mcpContent, setMcpContent] = useState("{}");
  useEffect(() => setMcpContent("{}"), [request.id]);
  if (payload.kind === "userInput") {
    return (
      <UserInputCard
        request={{ ...request, payload }}
        disabled={disabled}
        onRespond={onRespond}
      />
    );
  }
  if (payload.kind === "commandExecution") {
    const decisions = (
      payload.availableDecisions ?? ["accept", "decline"]
    ).filter(
      (decision) =>
        (decision !== "acceptWithExecpolicyAmendment" ||
          payload.proposedExecpolicyAmendment) &&
        (decision !== "applyNetworkPolicyAmendment" ||
          payload.proposedNetworkPolicyAmendments?.length),
    );
    return (
      <InteractionCard
        icon={SquareTerminal}
        title={
          payload.networkApprovalContext
            ? "Network approval"
            : "Command approval"
        }
        description={
          payload.reason ?? "Codex requested permission to run a command."
        }
      >
        {payload.command ? (
          <pre className="max-h-36 overflow-auto rounded-md bg-muted/70 p-2 text-xs whitespace-pre-wrap">
            {payload.command}
          </pre>
        ) : null}
        {!payload.command && payload.commandActions ? (
          <pre className="max-h-36 overflow-auto rounded-md bg-muted/70 p-2 text-xs whitespace-pre-wrap">
            {displayJson(payload.commandActions)}
          </pre>
        ) : null}
        {payload.cwd ? (
          <p className="truncate text-[11px] text-muted-foreground">
            Working directory: {payload.cwd}
          </p>
        ) : null}
        {payload.networkApprovalContext ? (
          <p className="text-xs">
            {payload.networkApprovalContext.protocol}://
            {payload.networkApprovalContext.host}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {decisions.map((decision) => (
            <Button
              key={decision}
              type="button"
              size="sm"
              variant={decision === "accept" ? "default" : "outline"}
              disabled={disabled}
              onClick={() =>
                onRespond(
                  request.id,
                  commandDecisionResponse(payload, decision),
                )
              }
            >
              {COMMAND_LABELS[decision]}
            </Button>
          ))}
        </div>
      </InteractionCard>
    );
  }
  if (payload.kind === "fileChange") {
    return (
      <InteractionCard
        icon={FilePenLine}
        title="File change approval"
        description={
          payload.reason ?? "Codex requested permission to change files."
        }
      >
        {payload.grantRoot ? (
          <p className="truncate text-xs text-muted-foreground">
            Root: {payload.grantRoot}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["accept", "Allow once"],
              ["acceptForSession", "Allow for session"],
              ["decline", "Deny"],
              ["cancel", "Cancel turn"],
            ] as const
          ).map(([decision, label]) => (
            <Button
              key={decision}
              type="button"
              size="sm"
              variant={decision === "accept" ? "default" : "outline"}
              disabled={disabled}
              onClick={() =>
                onRespond(request.id, { kind: "fileChange", decision })
              }
            >
              {label}
            </Button>
          ))}
        </div>
      </InteractionCard>
    );
  }
  if (payload.kind === "permissions") {
    return (
      <InteractionCard
        icon={KeyRound}
        title="Permission grant"
        description={
          payload.reason ?? "Codex requested additional permissions."
        }
      >
        <pre className="max-h-36 overflow-auto rounded-md bg-muted/70 p-2 text-xs whitespace-pre-wrap">
          {displayJson(payload.requestedPermissions)}
        </pre>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={disabled}
            onClick={() =>
              onRespond(request.id, {
                kind: "permissions",
                permissions: payload.requestedPermissions,
                scope: "turn",
                strictAutoReview: false,
              })
            }
          >
            Grant for turn
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              onRespond(request.id, {
                kind: "permissions",
                permissions: payload.requestedPermissions,
                scope: "session",
                strictAutoReview: false,
              })
            }
          >
            Grant for session
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              onRespond(request.id, {
                kind: "permissions",
                permissions: {},
                scope: "turn",
                strictAutoReview: false,
              })
            }
          >
            Deny
          </Button>
        </div>
      </InteractionCard>
    );
  }
  let parsedContent: Extract<
    AgentInteractionResponse,
    { kind: "mcpElicitation" }
  >["content"] = null;
  let validContent = true;
  if (payload.mode !== "url") {
    try {
      parsedContent = JSON.parse(mcpContent);
    } catch {
      validContent = false;
    }
  }
  return (
    <InteractionCard
      icon={PlugZap}
      title={`MCP request · ${payload.serverName}`}
      description={payload.message}
    >
      {payload.url ? (
        <a
          href={payload.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-sky-600 hover:underline dark:text-sky-400"
        >
          Open request <ExternalLink className="size-3" />
        </a>
      ) : null}
      {payload.mode !== "url" ? (
        <>
          {payload.requestedSchema ? (
            <pre className="max-h-32 overflow-auto rounded-md bg-muted/70 p-2 text-xs whitespace-pre-wrap">
              {displayJson(payload.requestedSchema)}
            </pre>
          ) : null}
          <textarea
            aria-label="MCP response JSON"
            rows={3}
            value={mcpContent}
            onChange={(event) => setMcpContent(event.target.value)}
            className="w-full rounded-md border bg-background p-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
          />
        </>
      ) : null}
      {!validContent ? (
        <p className="text-xs text-destructive">Enter valid JSON.</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={disabled || !validContent}
          onClick={() =>
            onRespond(request.id, {
              kind: "mcpElicitation",
              action: "accept",
              content: payload.mode === "url" ? null : parsedContent,
              metadata: payload.metadata,
            })
          }
        >
          Accept
        </Button>
        {(["decline", "cancel"] as const).map((action) => (
          <Button
            key={action}
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              onRespond(request.id, {
                kind: "mcpElicitation",
                action,
                content: null,
                metadata: payload.metadata,
              })
            }
          >
            {action === "decline" ? "Decline" : "Cancel turn"}
          </Button>
        ))}
      </div>
    </InteractionCard>
  );
}

export function AgentInteractionPanel({
  error,
  pendingRequestId,
  planQuestionId,
  requests,
  onRespond,
}: {
  error?: string | null;
  pendingRequestId: string | null;
  planQuestionId?: string | null;
  requests: AgentInteractionRequest[];
  onRespond(requestId: string, response: AgentInteractionResponse): void;
}) {
  const visible = requests.filter(
    (request) =>
      request.status === "pending" && request.requestKey !== planQuestionId,
  );
  if (!visible.length) return null;
  return (
    <div
      className="mb-2 max-h-[50vh] space-y-2 overflow-y-auto pr-1"
      aria-label="Pending Codex requests"
    >
      {visible.map((request) => (
        <InteractionRequestCard
          key={request.id}
          request={request}
          disabled={pendingRequestId !== null}
          onRespond={onRespond}
        />
      ))}
      {pendingRequestId ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Sending response…
        </p>
      ) : null}
      {error ? (
        <p className="flex items-center gap-1 text-xs text-destructive">
          <CircleAlert className="size-3" /> {error}
        </p>
      ) : null}
    </div>
  );
}

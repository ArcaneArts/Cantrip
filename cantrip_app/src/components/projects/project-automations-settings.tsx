import {
  describeProjectAutomationCondition,
  describeProjectAutomationSchedule,
  projectAutomationCreateSchema,
  type ProjectAutomation,
  type ProjectAutomationCondition,
  type ProjectAutomationIntervalUnit,
  type ProjectAutomationSchedule,
} from "@cantrip/protocol/automations";
import type { ChatSummary } from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock,
  CalendarClock,
  FileText,
  ListChecks,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SettingsTabBar } from "@/components/settings/settings-controls";
import {
  createProjectAutomation,
  deleteProjectAutomation,
  getProjectAutomations,
  updateProjectAutomation,
} from "@/lib/project-automation-api";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/error-message";

const dayOptions = [
  { label: "Sun", value: 0 },
  { label: "Mon", value: 1 },
  { label: "Tue", value: 2 },
  { label: "Wed", value: 3 },
  { label: "Thu", value: 4 },
  { label: "Fri", value: 5 },
  { label: "Sat", value: 6 },
] as const;

const intervalUnits: ProjectAutomationIntervalUnit[] = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "year",
];

function errorText(error: unknown): string {
  return errorMessage(error, "The automation failed.");
}

function localInputValue(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function defaultStart(): string {
  const date = new Date(Date.now() + 5 * 60_000);
  date.setSeconds(0, 0);
  return localInputValue(date);
}

function formatRun(value: string | null): string {
  if (!value) return "Not scheduled";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

type ScheduleMode = ProjectAutomationSchedule["kind"];
type ConditionMode = "none" | ProjectAutomationCondition["type"];
type AutomationDialogTab = "details" | "schedule" | "condition";

const automationDialogTabs = [
  { id: "details", label: "Details", icon: FileText },
  { id: "schedule", label: "Schedule", icon: CalendarClock },
  { id: "condition", label: "Condition", icon: ListChecks },
] as const;

function AutomationDialog({
  automation,
  chats,
  onOpenChange,
  open,
  projectId,
}: {
  automation: ProjectAutomation | null;
  chats: ChatSummary[];
  onOpenChange(open: boolean): void;
  open: boolean;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [chatId, setChatId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [activeTab, setActiveTab] = useState<AutomationDialogTab>("details");
  const [mode, setMode] = useState<ScheduleMode>("interval");
  const [every, setEvery] = useState("5");
  const [unit, setUnit] = useState<ProjectAutomationIntervalUnit>("minute");
  const [startsAt, setStartsAt] = useState(defaultStart);
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [weeklyTime, setWeeklyTime] = useState("09:00");
  const [cronExpression, setCronExpression] = useState("0 9 * * 1-5");
  const [conditionMode, setConditionMode] = useState<ConditionMode>("none");
  const [conditionScript, setConditionScript] = useState("");
  const [minimumOpenIssues, setMinimumOpenIssues] = useState("1");
  const [timeZone, setTimeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );

  useEffect(() => {
    if (!open) return;
    setName(automation?.name ?? "");
    setActiveTab("details");
    setChatId(automation?.chatId ?? chats[0]?.id ?? "");
    setPrompt(automation?.prompt ?? "");
    const condition = automation?.condition;
    setConditionMode(condition?.type ?? "none");
    setConditionScript(condition?.type === "script" ? condition.script : "");
    setMinimumOpenIssues(
      condition?.type === "open-issues" ? String(condition.minimum) : "1",
    );
    const schedule = automation?.schedule;
    setMode(schedule?.kind ?? "interval");
    if (schedule?.kind === "interval") {
      setEvery(String(schedule.every));
      setUnit(schedule.unit);
      setStartsAt(localInputValue(new Date(schedule.startsAt)));
    } else {
      setEvery("5");
      setUnit("minute");
      setStartsAt(defaultStart());
    }
    if (schedule?.kind === "weekly") {
      setWeekdays(schedule.weekdays);
      setWeeklyTime(
        `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`,
      );
      setTimeZone(schedule.timeZone);
    } else if (schedule?.kind === "cron") {
      setCronExpression(schedule.expression);
      setTimeZone(schedule.timeZone);
    } else {
      setWeekdays([1, 2, 3, 4, 5]);
      setWeeklyTime("09:00");
      setCronExpression("0 9 * * 1-5");
      setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    }
  }, [automation, chats, open]);

  const save = useMutation({
    mutationFn: async () => {
      let schedule: ProjectAutomationSchedule;
      if (mode === "interval") {
        schedule = {
          kind: "interval",
          every: Number(every),
          unit,
          startsAt: new Date(startsAt).toISOString(),
        };
      } else if (mode === "weekly") {
        const [hour, minute] = weeklyTime.split(":").map(Number);
        schedule = {
          kind: "weekly",
          weekdays,
          hour: hour ?? 0,
          minute: minute ?? 0,
          timeZone,
        };
      } else {
        schedule = {
          kind: "cron",
          expression: cronExpression,
          timeZone,
        };
      }
      const condition: ProjectAutomationCondition | null =
        conditionMode === "script"
          ? { type: "script", script: conditionScript }
          : conditionMode === "open-issues"
            ? { type: "open-issues", minimum: Number(minimumOpenIssues) }
            : null;
      const input = projectAutomationCreateSchema.parse({
        name,
        chatId,
        prompt,
        schedule,
        condition,
        enabled: automation?.enabled ?? true,
      });
      return automation
        ? updateProjectAutomation(automation.id, input)
        : createProjectAutomation(projectId, input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["project-automations", projectId],
      });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {automation ? "Edit automation" : "New automation"}
          </DialogTitle>
          <DialogDescription>
            The assigned worker pulls this schedule from Cantrip Server and
            submits the prompt to the selected agent when it is due.
          </DialogDescription>
        </DialogHeader>

        <SettingsTabBar<AutomationDialogTab>
          activeTab={activeTab}
          ariaLabel="Automation sections"
          onTabChange={setActiveTab}
          tabs={automationDialogTabs}
        />

        <div className="min-h-[22rem] py-1">
          {activeTab === "details" ? (
            <div className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm">
                  <span className="font-medium">Name</span>
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Review open pull requests"
                  />
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className="font-medium">Target agent</span>
                  <select
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={chatId}
                    onChange={(event) => setChatId(event.target.value)}
                  >
                    {chats.map((chat) => (
                      <option key={chat.id} value={chat.id}>
                        {chat.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Prompt</span>
                <textarea
                  className="min-h-40 resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-2"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Check the project and report anything that needs attention."
                />
              </label>
            </div>
          ) : null}

          {activeTab === "schedule" ? (
            <div className="grid gap-4">
              <label className="grid gap-1.5 text-sm sm:max-w-xs">
                <span className="font-medium">Schedule</span>
                <select
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  value={mode}
                  onChange={(event) =>
                    setMode(event.target.value as ScheduleMode)
                  }
                >
                  <option value="interval">Every interval</option>
                  <option value="weekly">Selected weekdays</option>
                  <option value="cron">Advanced cron</option>
                </select>
              </label>

              {mode === "interval" ? (
                <div className="grid gap-3 sm:grid-cols-[8rem_1fr_1.4fr]">
                  <label className="grid gap-1.5 text-sm">
                    <span className="font-medium">Every</span>
                    <Input
                      min={1}
                      type="number"
                      value={every}
                      onChange={(event) => setEvery(event.target.value)}
                    />
                  </label>
                  <label className="grid gap-1.5 text-sm">
                    <span className="font-medium">Unit</span>
                    <select
                      className="h-9 rounded-md border bg-background px-3 text-sm capitalize"
                      value={unit}
                      onChange={(event) =>
                        setUnit(
                          event.target.value as ProjectAutomationIntervalUnit,
                        )
                      }
                    >
                      {intervalUnits.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1.5 text-sm">
                    <span className="font-medium">First run / anchor</span>
                    <Input
                      type="datetime-local"
                      value={startsAt}
                      onChange={(event) => setStartsAt(event.target.value)}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground sm:col-span-3">
                    Month and year intervals stay anchored to this calendar
                    date. For example, choose every 2 years and September 27 for
                    a biennial run.
                  </p>
                </div>
              ) : null}

              {mode === "weekly" ? (
                <div className="grid gap-3">
                  <div className="flex flex-wrap gap-1.5">
                    {dayOptions.map((day) => {
                      const selected = weekdays.includes(day.value);
                      return (
                        <Button
                          key={day.value}
                          type="button"
                          size="sm"
                          variant={selected ? "default" : "outline"}
                          aria-pressed={selected}
                          onClick={() =>
                            setWeekdays((current) =>
                              selected
                                ? current.filter((value) => value !== day.value)
                                : [...current, day.value].sort(),
                            )
                          }
                        >
                          {day.label}
                        </Button>
                      );
                    })}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1.5 text-sm">
                      <span className="font-medium">Time</span>
                      <Input
                        type="time"
                        value={weeklyTime}
                        onChange={(event) => setWeeklyTime(event.target.value)}
                      />
                    </label>
                    <label className="grid gap-1.5 text-sm">
                      <span className="font-medium">Time zone</span>
                      <Input
                        value={timeZone}
                        onChange={(event) => setTimeZone(event.target.value)}
                      />
                    </label>
                  </div>
                </div>
              ) : null}

              {mode === "cron" ? (
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
                  <label className="grid gap-1.5 text-sm">
                    <span className="font-medium">Cron expression</span>
                    <Input
                      className="font-mono"
                      value={cronExpression}
                      onChange={(event) =>
                        setCronExpression(event.target.value)
                      }
                      placeholder="0 9 * * 1-5"
                    />
                  </label>
                  <label className="grid gap-1.5 text-sm">
                    <span className="font-medium">Time zone</span>
                    <Input
                      value={timeZone}
                      onChange={(event) => setTimeZone(event.target.value)}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    Standard five-field cron: minute, hour, day of month, month,
                    weekday. Example: <code>0 9 * * 1-5</code> runs at 9:00 AM
                    on weekdays.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          {activeTab === "condition" ? (
            <div className="grid gap-4">
              <div>
                <h3 className="text-sm font-medium">Run condition</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  The assigned worker checks this condition when an occurrence
                  is due. A false result skips that occurrence and keeps the
                  automation enabled for its next scheduled check.
                </p>
              </div>
              <label className="grid gap-1.5 text-sm sm:max-w-md">
                <span className="font-medium">Condition type</span>
                <select
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  value={conditionMode}
                  onChange={(event) =>
                    setConditionMode(event.target.value as ConditionMode)
                  }
                >
                  <option value="none">No condition</option>
                  <option value="script">Script exit code</option>
                  <option value="open-issues">Minimum open issues</option>
                </select>
              </label>

              {conditionMode === "script" ? (
                <label className="grid gap-1.5 text-sm">
                  <span className="font-medium">Script</span>
                  <textarea
                    className="min-h-40 resize-y rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-2"
                    value={conditionScript}
                    onChange={(event) => setConditionScript(event.target.value)}
                    placeholder="pnpm test"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Runs in the target agent&apos;s active worktree. Exit code 0
                    allows the automation; every other exit code skips it.
                  </span>
                </label>
              ) : null}

              {conditionMode === "open-issues" ? (
                <label className="grid max-w-xs gap-1.5 text-sm">
                  <span className="font-medium">Minimum open issues</span>
                  <Input
                    min={1}
                    type="number"
                    value={minimumOpenIssues}
                    onChange={(event) =>
                      setMinimumOpenIssues(event.target.value)
                    }
                  />
                  <span className="text-xs text-muted-foreground">
                    Runs only when the GitHub issue tracker contains at least
                    this many open issues. Pull requests are not counted.
                  </span>
                </label>
              ) : null}

              {conditionMode === "none" ? (
                <p className="border-y py-4 text-sm text-muted-foreground">
                  Every due occurrence will run without an additional check.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {save.error ? (
          <p className="text-sm text-destructive">{errorText(save.error)}</p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!chats.length || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            {automation ? "Save changes" : "Create automation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectAutomationsSettings({
  chats,
  projectId,
}: {
  chats: ChatSummary[];
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectAutomation | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectAutomation | null>(
    null,
  );
  const automations = useQuery({
    queryKey: ["project-automations", projectId],
    queryFn: () => getProjectAutomations(projectId),
    refetchInterval: 10_000,
  });

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: ["project-automations", projectId],
    });
  const toggle = useMutation({
    mutationFn: (automation: ProjectAutomation) =>
      updateProjectAutomation(automation.id, {
        enabled: !automation.enabled,
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (automation: ProjectAutomation) =>
      deleteProjectAutomation(automation.id),
    onSuccess: () => {
      setDeleteTarget(null);
      void refresh();
    },
  });
  const rows = automations.data ?? [];
  const operationError = automations.error ?? toggle.error ?? remove.error;

  const enabledCount = useMemo(
    () => rows.filter(({ enabled }) => enabled).length,
    [rows],
  );

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <CalendarClock className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div>
            <h2 className="font-semibold">
              Automations{" "}
              <span className="text-muted-foreground">({rows.length})</span>
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {enabledCount} active. Schedules are stored on the server and
              pulled by the worker assigned to each target agent.
            </p>
          </div>
        </div>
        <Button
          disabled={!chats.length}
          onClick={() => {
            setEditing(null);
            setEditorOpen(true);
          }}
        >
          <Plus className="size-4" /> New automation
        </Button>
      </div>

      {!chats.length ? (
        <div className="border-y px-4 py-10 text-center text-sm text-muted-foreground">
          Create an agent in this project before adding an automation.
        </div>
      ) : null}

      {operationError ? (
        <p className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {errorText(operationError)}
        </p>
      ) : null}

      {automations.isLoading ? (
        <div className="grid place-items-center py-16 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : rows.length ? (
        <div className="border-y">
          <div className="hidden grid-cols-[minmax(12rem,1.1fr)_minmax(9rem,0.8fr)_minmax(13rem,1fr)_minmax(10rem,0.8fr)_7rem] gap-3 border-b px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground md:grid">
            <span>Automation</span>
            <span>Target agent</span>
            <span>Schedule</span>
            <span>Next run</span>
            <span className="text-right">Actions</span>
          </div>
          <div className="divide-y">
            {rows.map((automation) => (
              <div
                key={automation.id}
                data-high-contrast-row
                className="grid gap-2 px-3 py-2.5 odd:bg-muted/[0.18] md:grid-cols-[minmax(12rem,1.1fr)_minmax(9rem,0.8fr)_minmax(13rem,1fr)_minmax(10rem,0.8fr)_7rem] md:items-center md:gap-3"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <AlarmClock
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground",
                      automation.enabled && "text-emerald-500",
                    )}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {automation.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {automation.enabled ? "Active" : "Paused"}
                      {automation.lastStatus !== "idle"
                        ? ` · ${automation.lastStatus}`
                        : ""}
                    </p>
                  </div>
                </div>
                <p className="truncate text-sm">{automation.chatTitle}</p>
                <div className="min-w-0 text-xs text-muted-foreground">
                  <p className="truncate">
                    {describeProjectAutomationSchedule(automation.schedule)}
                  </p>
                  {automation.condition ? (
                    <p className="truncate">
                      Condition:{" "}
                      {describeProjectAutomationCondition(automation.condition)}
                    </p>
                  ) : null}
                </div>
                <div className="min-w-0 text-xs">
                  <p className="truncate">
                    {automation.enabled
                      ? formatRun(automation.nextRunAt)
                      : "Paused"}
                  </p>
                  {automation.lastError ? (
                    <p
                      className="truncate text-destructive"
                      title={automation.lastError}
                    >
                      {automation.lastError}
                    </p>
                  ) : null}
                </div>
                <div className="flex justify-end gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate(automation)}
                  >
                    {automation.enabled ? (
                      <Pause className="size-4" />
                    ) : (
                      <Play className="size-4" />
                    )}
                    <span className="sr-only">
                      {automation.enabled ? "Pause" : "Resume"}{" "}
                      {automation.name}
                    </span>
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                      setEditing(automation);
                      setEditorOpen(true);
                    }}
                  >
                    <Pencil className="size-4" />
                    <span className="sr-only">Edit {automation.name}</span>
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setDeleteTarget(automation)}
                  >
                    <Trash2 className="size-4" />
                    <span className="sr-only">Delete {automation.name}</span>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : chats.length ? (
        <div className="border-y px-4 py-12 text-center">
          <CalendarClock className="mx-auto size-7 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">No automations yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Schedule a prompt to run in one of this project&apos;s agents.
          </p>
        </div>
      ) : null}

      <AutomationDialog
        automation={editing}
        chats={chats}
        onOpenChange={setEditorOpen}
        open={editorOpen}
        projectId={projectId}
      />

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
            <DialogDescription>
              Future scheduled prompts will stop immediately. Existing agent
              conversation messages and already queued prompts are retained.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={() => deleteTarget && remove.mutate(deleteTarget)}
            >
              {remove.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Delete automation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

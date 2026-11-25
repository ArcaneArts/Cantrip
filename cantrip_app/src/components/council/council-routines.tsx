import { describeProjectAutomationSchedule } from "@cantrip/protocol/automations";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  History,
  Pause,
  Pencil,
  Play,
  Plus,
} from "lucide-react";
import { useState } from "react";

import { AutomationRunLink } from "@/components/chat/automation-run-link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { InlineAlert } from "@/components/ui/inline-alert";
import { errorMessage } from "@/lib/error-message";
import {
  createCouncilAutomation,
  getCouncilAutomationRuns,
  getCouncilRoutineSummaries,
  updateCouncilAutomation,
} from "@/lib/project-automation-api";

import { CouncilRoutineEditor } from "./council-routine-editor";

export type CouncilRoutine = Awaited<
  ReturnType<typeof getCouncilRoutineSummaries>
>[number];

export function CouncilRoutines({ agentId }: { agentId: string }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<CouncilRoutine | "new" | null>(null);
  const [history, setHistory] = useState<CouncilRoutine | null>(null);
  const key = ["council-automations", agentId];
  const routines = useQuery({
    queryKey: key,
    queryFn: () => getCouncilRoutineSummaries(agentId),
    enabled: open,
  });
  const runs = useQuery({
    queryKey: ["council-automation-runs", agentId, history?.id],
    queryFn: () => getCouncilAutomationRuns(agentId, history?.id ?? ""),
    enabled: open && history !== null,
  });
  const write = useMutation({
    mutationFn: ({
      routine,
      values,
    }: {
      routine?: CouncilRoutine;
      values: Parameters<typeof updateCouncilAutomation>[1];
    }) => {
      if (routine) return updateCouncilAutomation(routine.id, values);
      if (!values.name || !values.prompt || !values.schedule) {
        throw new Error("Enter a name, a trigger prompt, and a schedule.");
      }
      return createCouncilAutomation(agentId, {
        name: values.name,
        prompt: values.prompt,
        schedule: values.schedule,
        enabled: true,
      });
    },
    onSuccess: async () => {
      setEditor(null);
      await client.invalidateQueries({ queryKey: key });
    },
  });
  function opened(next: boolean) {
    setOpen(next);
    if (!next) {
      setEditor(null);
      setHistory(null);
      write.reset();
    }
  }
  function edit(routine: CouncilRoutine | "new") {
    write.reset();
    setEditor(routine);
  }
  return (
    <Dialog open={open} onOpenChange={opened}>
      <DialogTrigger asChild>
        <Button aria-label="Council routines" size="icon" variant="ghost">
          <CalendarClock className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editor
              ? editor === "new"
                ? "New routine"
                : "Edit routine"
              : history
                ? "Run history"
                : "Council routines"}
          </DialogTitle>
          <DialogDescription>
            {history ? history.name : "Schedule prompts for this agent."}
          </DialogDescription>
        </DialogHeader>
        {write.isError ? (
          <InlineAlert>{errorMessage(write.error)}</InlineAlert>
        ) : null}
        {editor ? (
          <CouncilRoutineEditor
            key={editor === "new" ? "new" : editor.id}
            routine={editor === "new" ? undefined : editor}
            pending={write.isPending}
            onCancel={() => setEditor(null)}
            onSave={(values) =>
              write.mutate({
                routine: editor === "new" ? undefined : editor,
                values,
              })
            }
          />
        ) : history ? (
          <>
            <Button
              className="w-fit"
              size="sm"
              variant="outline"
              onClick={() => setHistory(null)}
            >
              Back to routines
            </Button>
            {runs.isPending ? (
              <p role="status" className="text-sm">
                Loading runs…
              </p>
            ) : null}
            {runs.isError ? (
              <InlineAlert>{errorMessage(runs.error)}</InlineAlert>
            ) : null}
            {runs.data?.length === 0 ? (
              <p className="text-sm text-muted-foreground">No runs yet.</p>
            ) : null}
            <ul className="space-y-2">
              {runs.data?.map((run) => (
                <li key={run.id}>
                  <AutomationRunLink
                    source={{
                      automationId: history.id,
                      runId: run.id,
                      name: history.name,
                      targetKind: "council",
                    }}
                    label={`${new Date(run.scheduledFor).toLocaleString()} · ${run.status}`}
                  />
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <Button className="w-fit" size="sm" onClick={() => edit("new")}>
              <Plus className="size-4" /> New routine
            </Button>
            {routines.isPending ? (
              <p role="status" className="text-sm">
                Loading routines…
              </p>
            ) : null}
            {routines.isError ? (
              <InlineAlert>{errorMessage(routines.error)}</InlineAlert>
            ) : null}
            {routines.data?.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No routines scheduled.
              </p>
            ) : null}
            <ul className="divide-y">
              {routines.data?.map((routine) => (
                <li
                  className="flex min-w-0 items-center gap-2 py-2"
                  key={routine.id}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {routine.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {routine.enabled
                        ? describeProjectAutomationSchedule(routine.schedule)
                        : "Paused"}
                    </p>
                  </div>
                  <Button
                    aria-label={`${routine.enabled ? "Pause" : "Resume"} ${routine.name}`}
                    size="icon"
                    variant="ghost"
                    disabled={write.isPending}
                    onClick={() =>
                      write.mutate({
                        routine,
                        values: { enabled: !routine.enabled },
                      })
                    }
                  >
                    {routine.enabled ? (
                      <Pause className="size-4" />
                    ) : (
                      <Play className="size-4" />
                    )}
                  </Button>
                  <Button
                    aria-label={`Edit ${routine.name}`}
                    size="icon"
                    variant="ghost"
                    onClick={() => edit(routine)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    aria-label={`Runs for ${routine.name}`}
                    size="icon"
                    variant="ghost"
                    onClick={() => setHistory(routine)}
                  >
                    <History className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

import {
  projectAutomationIntervalUnitSchema,
  projectAutomationScheduleSchema,
  type ProjectAutomationSchedule,
} from "@cantrip/protocol/automations";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import type { CouncilRoutine } from "./council-routines";

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const units = projectAutomationIntervalUnitSchema.options;
function localInputDate(value: Date): string {
  return new Date(value.valueOf() - value.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export function CouncilRoutineEditor({
  routine,
  pending,
  onCancel,
  onSave,
}: {
  routine?: CouncilRoutine;
  pending: boolean;
  onCancel(): void;
  onSave(input: {
    name: string;
    prompt: string;
    schedule: ProjectAutomationSchedule;
  }): void;
}) {
  const saved = routine?.schedule;
  const [kind, setKind] = useState<ProjectAutomationSchedule["kind"]>(
    saved?.kind ?? "interval",
  );
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [every, setEvery] = useState(
    saved?.kind === "interval" ? String(saved.every) : "1",
  );
  const [unit, setUnit] = useState(
    saved?.kind === "interval" ? saved.unit : "day",
  );
  const [starts, setStarts] = useState(() =>
    localInputDate(
      saved?.kind === "interval"
        ? new Date(saved.startsAt)
        : new Date(Date.now() + 5 * 60_000),
    ),
  );
  const [weekdays, setWeekdays] = useState(
    saved?.kind === "weekly" ? saved.weekdays : [1, 2, 3, 4, 5],
  );
  const [time, setTime] = useState(
    saved?.kind === "weekly"
      ? [saved.hour, saved.minute]
          .map((value) => String(value).padStart(2, "0"))
          .join(":")
      : "09:00",
  );
  const [expression, setExpression] = useState(
    saved?.kind === "cron" ? saved.expression : "0 9 * * 1-5",
  );
  const [timeZone, setTimeZone] = useState(
    saved?.kind === "cron" || saved?.kind === "weekly"
      ? saved.timeZone
      : Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const start = new Date(starts);
    const [hour, minute] = time.split(":").map(Number);
    const schedule = projectAutomationScheduleSchema.safeParse(
      kind === "interval"
        ? {
            kind,
            every: Number(every),
            unit,
            startsAt: Number.isFinite(start.valueOf())
              ? start.toISOString()
              : "",
          }
        : kind === "weekly"
          ? { kind, weekdays, hour, minute, timeZone }
          : { kind, expression, timeZone },
    );
    if (!name.trim() || !prompt.trim() || !schedule.success) {
      setError(
        !name.trim() || !prompt.trim()
          ? "Enter a name and a trigger prompt."
          : (schedule.error?.issues[0]?.message ?? "Enter a valid schedule."),
      );
      return;
    }
    setError(null);
    onSave({ name, prompt, schedule: schedule.data });
  }
  return (
    <form onSubmit={submit} className="min-w-0 space-y-3">
      <label className="grid gap-1 text-sm">
        Routine name
        <Input
          required
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="grid gap-1 text-sm">
        Trigger prompt
        <textarea
          className="min-h-24 resize-y rounded-md border bg-background px-3 py-2"
          required
          value={prompt}
          maxLength={100_000}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <label className="grid gap-1 text-sm">
        Schedule type
        <NativeSelect
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as ProjectAutomationSchedule["kind"])
          }
        >
          <option value="interval">Interval</option>
          <option value="weekly">Weekly</option>
          <option value="cron">Cron</option>
        </NativeSelect>
      </label>
      {kind === "interval" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            Repeat every
            <Input
              type="number"
              min={1}
              max={1_000_000}
              required
              value={every}
              onChange={(event) => setEvery(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Interval unit
            <NativeSelect
              value={unit}
              onChange={(event) =>
                setUnit(
                  projectAutomationIntervalUnitSchema.parse(event.target.value),
                )
              }
            >
              {units.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="grid gap-1 text-sm sm:col-span-2">
            First occurrence
            <Input
              type="datetime-local"
              required
              value={starts}
              onChange={(event) => setStarts(event.target.value)}
            />
          </label>
        </div>
      ) : null}
      {kind === "weekly" ? (
        <>
          <fieldset>
            <legend className="mb-1 text-sm">Repeat on</legend>
            <div className="flex flex-wrap gap-1">
              {days.map((day, index) => (
                <Button
                  key={day}
                  type="button"
                  size="sm"
                  variant={weekdays.includes(index) ? "default" : "outline"}
                  aria-pressed={weekdays.includes(index)}
                  onClick={() =>
                    setWeekdays((current) =>
                      current.includes(index)
                        ? current.filter((value) => value !== index)
                        : [...current, index],
                    )
                  }
                >
                  {day}
                </Button>
              ))}
            </div>
          </fieldset>
          <label className="grid gap-1 text-sm">
            Start time
            <Input
              type="time"
              required
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
          </label>
        </>
      ) : null}
      {kind === "cron" ? (
        <label className="grid gap-1 text-sm">
          Cron expression
          <Input
            required
            value={expression}
            onChange={(event) => setExpression(event.target.value)}
          />
        </label>
      ) : null}
      {kind !== "interval" ? (
        <label className="grid gap-1 text-sm">
          Time zone
          <Input
            required
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
          />
        </label>
      ) : null}
      {error ? <InlineAlert>{error}</InlineAlert> : null}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save routine"}
        </Button>
      </div>
    </form>
  );
}

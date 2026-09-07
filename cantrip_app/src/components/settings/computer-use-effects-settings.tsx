import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CUA_EFFECT_OFF,
  CUA_EFFECTS,
  cuaEffectConfigurationSchema,
  cuaEffectWorkerStatusSchema,
  type CuaEffectConfiguration,
} from "@cantrip/protocol/computer-use-effects";
import { request } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/error-message";

export function ComputerUseEffectsSettings({
  configuration = CUA_EFFECT_OFF,
  pending,
  onChange,
  workers,
}: {
  configuration?: CuaEffectConfiguration;
  pending: boolean;
  onChange(configuration: CuaEffectConfiguration): void;
  workers: Array<{ workerId: string; name: string }>;
}) {
  const [chosenWorker, setChosenWorker] = useState("");
  const workerId =
    workers.find((worker) => worker.workerId === chosenWorker)?.workerId ??
    workers[0]?.workerId;
  const status = useQuery({
    queryKey: ["computer-use-effects", workerId, configuration],
    enabled: Boolean(workerId),
    queryFn: async ({ signal }) =>
      cuaEffectWorkerStatusSchema.parse(
        await request(
          `/api/settings/computer-use/workers/${encodeURIComponent(workerId!)}/effects`,
          { signal },
        ),
      ),
    refetchInterval: configuration.effect === "off" ? false : 5_000,
    retry: false,
  });
  const debug =
    configuration.effect === "debug-gradient" ? configuration.parameters : null;
  const warp =
    configuration.effect === "cursor-warp" ? configuration.parameters : null;
  const setParameter = (
    key: "strength" | "radius" | "showTelemetry",
    value: number,
  ) => {
    if (!debug) return;
    const next = cuaEffectConfigurationSchema.safeParse({
      effect: "debug-gradient",
      parameters: { ...debug, [key]: value },
    });
    if (next.success) onChange(next.data);
  };
  const native = status.data?.native;
  const failures = native?.windows.filter((window) => window.error) ?? [];
  return (
    <div className="mt-3 space-y-3 border-t pt-3 text-xs">
      <div>
        <h3 className="font-semibold">Window effects</h3>
        <p className="mt-1 text-muted-foreground">
          Filter the window on the worker’s Mac. Agent screenshots keep the
          original colors, and agent cursors stay above the effect. Requires
          macOS 14 or later.
        </p>
      </div>
      <label className="flex items-center justify-between gap-3">
        Effect
        <select
          aria-label="Window effect"
          className="rounded-md border bg-background px-2 py-1.5"
          disabled={pending}
          value={configuration.effect}
          onChange={(event) =>
            onChange(
              cuaEffectConfigurationSchema.parse({
                effect: event.target.value,
                parameters: {},
              }),
            )
          }
        >
          {CUA_EFFECTS.map((effect) => (
            <option key={effect.id} value={effect.id}>
              {effect.label}
            </option>
          ))}
        </select>
      </label>
      {debug ? (
        <div className="space-y-2">
          <label className="flex items-center justify-between gap-3">
            Inversion strength
            <input
              aria-label="Inversion strength"
              type="number"
              min={0}
              max={1}
              step={0.05}
              disabled={pending}
              className="w-24 rounded-md border bg-background px-2 py-1"
              key={`strength:${debug.strength}`}
              defaultValue={debug.strength ?? 1}
              onBlur={(event) =>
                setParameter("strength", event.target.valueAsNumber)
              }
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            Feedback radius (points)
            <input
              aria-label="Feedback radius"
              type="number"
              min={16}
              max={320}
              step={1}
              disabled={pending}
              className="w-24 rounded-md border bg-background px-2 py-1"
              key={`radius:${debug.radius}`}
              defaultValue={debug.radius ?? 80}
              onBlur={(event) =>
                setParameter("radius", event.target.valueAsNumber)
              }
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={(debug.showTelemetry ?? 1) === 1}
              disabled={pending}
              onChange={(event) =>
                setParameter("showTelemetry", event.target.checked ? 1 : 0)
              }
            />
            Show cursor velocity and input feedback
          </label>
        </div>
      ) : null}
      {warp ? (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            A subtle lens at rest, a stronger wake during movement, and a brief
            ripple on clicks. Only the window image bends; input coordinates
            stay unchanged. Lower dissipation lingers like molasses; higher
            values settle faster.
          </p>
          {(
            [
              {
                key: "strength",
                label: "Warp strength",
                fallback: 1,
                min: 0,
                max: 2,
                step: 0.05,
              },
              {
                key: "radius",
                label: "Warp radius (points)",
                fallback: 110,
                min: 32,
                max: 320,
                step: 1,
              },
              {
                key: "motion",
                label: "Motion response",
                fallback: 1,
                min: 0,
                max: 2,
                step: 0.05,
              },
              {
                key: "dissipation",
                label: "Dissipation speed",
                fallback: 1,
                min: 0.1,
                max: 5,
                step: 0.1,
              },
              {
                key: "ripple",
                label: "Click ripple",
                fallback: 1,
                min: 0,
                max: 2,
                step: 0.05,
              },
            ] as const
          ).map((parameter) => (
            <label
              key={parameter.key}
              className="flex items-center justify-between gap-3"
            >
              {parameter.label}
              <input
                aria-label={parameter.label}
                type="number"
                min={parameter.min}
                max={parameter.max}
                step={parameter.step}
                disabled={pending}
                className="w-24 rounded-md border bg-background px-2 py-1"
                key={`${parameter.key}:${warp[parameter.key]}`}
                defaultValue={warp[parameter.key] ?? parameter.fallback}
                onBlur={(event) => {
                  const next = cuaEffectConfigurationSchema.safeParse({
                    effect: "cursor-warp",
                    parameters: {
                      ...warp,
                      [parameter.key]: event.target.valueAsNumber,
                    },
                  });
                  if (next.success) onChange(next.data);
                }}
              />
            </label>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          Worker
          <select
            aria-label="Effects worker"
            className="rounded-md border bg-background px-2 py-1"
            value={workerId ?? ""}
            onChange={(event) => setChosenWorker(event.target.value)}
          >
            {!workers.length ? <option value="">No workers</option> : null}
            {workers.map((worker) => (
              <option value={worker.workerId} key={worker.workerId}>
                {worker.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={!workerId || status.isFetching}
          onClick={() => void status.refetch()}
        >
          Refresh effect status
        </Button>
      </div>
      <p className="text-muted-foreground" role="status">
        {status.data?.state === "idle"
          ? "Ready for the next computer-use session. No capture is running."
          : native?.supported === false
            ? "Window effects are unsupported on this worker."
            : native?.compiling
              ? "Compiling effect…"
              : native?.windows.some((window) => window.phase === "presenting")
                ? "Effect presentation is active."
                : configuration.effect === "off"
                  ? "Window effects are off."
                  : "Effects will appear on windows attached through computer use."}
      </p>
      {native?.shaderSource &&
      native.shaderSource !== "bundled-effects.metal" ? (
        <p className="break-all text-muted-foreground">
          Development shader: {native.shaderSource}
        </p>
      ) : null}
      {native?.shaderError && native.activeEffect ? (
        <p className="text-muted-foreground">
          The last working effect remains active.
        </p>
      ) : null}
      {status.error ||
      status.data?.error ||
      native?.shaderError ||
      failures.length ? (
        <p role="alert" className="text-destructive">
          {status.error
            ? errorMessage(status.error)
            : (status.data?.error ??
              native?.shaderError ??
              failures.map((window) => window.error).join(" "))}
        </p>
      ) : null}
    </div>
  );
}

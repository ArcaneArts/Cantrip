import {
  Activity,
  AlertTriangle,
  Boxes,
  Check,
  CircleGauge,
  Database,
  Ellipsis,
  List,
  LoaderCircle,
  PanelRightClose,
  PanelRightOpen,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Table2,
  Text,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  DEFAULT_ELITE_REVEAL_CONFIG,
  ELITE_GLITCH_VARIANTS,
  EliteReveal,
  eliteRevealConfigSignature,
  normalizeEliteRevealConfig,
  type EliteGlitchVariant,
  type EliteRevealConfig,
  type EliteRevealContentKind,
} from "@/components/elite/elite-reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  NavigationTabBar,
  type NavigationTab,
} from "@/components/ui/navigation-tab-bar";
import { NativeSelect } from "@/components/ui/native-select";
import {
  ResizablePanel,
  clampResizablePanelWidth,
  resizablePanelWidthFromKey,
  resizablePanelWidthFromPointer,
} from "@/components/ui/resizable-panel";
import { cn } from "@/lib/utils";

type EliteLabView = "cards" | "list" | "table" | "text" | "widgets";

const eliteLabTabs: readonly NavigationTab<EliteLabView>[] = [
  { id: "list", label: "List", icon: List },
  { id: "cards", label: "Cards", icon: Boxes },
  { id: "text", label: "Text", icon: Text },
  { id: "table", label: "Table", icon: Table2 },
  { id: "widgets", label: "Widgets", icon: CircleGauge },
];

const variantLabels: Record<EliteGlitchVariant, string> = {
  chromatic: "Chromatic shift",
  "full-frame": "Full bright frame",
  "left-frame": "Left half frame",
  outline: "Bright outline",
  "right-frame": "Right half frame",
  scanline: "Scanline bands",
  "spatial-shift": "Spatial shift",
  "text-jitter": "Text jitter",
};

const viewItemCounts: Record<EliteLabView, number> = {
  cards: 18,
  list: 48,
  table: 32,
  text: 12,
  widgets: 20,
};

export const DEFAULT_ELITE_CONFIGURATOR_WIDTH = 384;
export const MIN_ELITE_CONFIGURATOR_WIDTH = 320;
export const MAX_ELITE_CONFIGURATOR_WIDTH = 640;
export const ELITE_CONFIGURATOR_WIDTH_STORAGE_KEY =
  "cantrip:elite-configurator-width";

export function clampEliteConfiguratorWidth(width: number): number {
  return clampResizablePanelWidth(
    width,
    DEFAULT_ELITE_CONFIGURATOR_WIDTH,
    MIN_ELITE_CONFIGURATOR_WIDTH,
    MAX_ELITE_CONFIGURATOR_WIDTH,
  );
}

export function eliteConfiguratorWidthFromPointer(
  clientX: number,
  panelRight: number,
): number {
  return resizablePanelWidthFromPointer({
    boundary: panelRight,
    clientX,
    defaultWidth: DEFAULT_ELITE_CONFIGURATOR_WIDTH,
    edge: "left",
    maxWidth: MAX_ELITE_CONFIGURATOR_WIDTH,
    minWidth: MIN_ELITE_CONFIGURATOR_WIDTH,
  });
}

export function eliteConfiguratorWidthFromKey(
  currentWidth: number,
  key: string,
): number | null {
  return resizablePanelWidthFromKey({
    currentWidth,
    defaultWidth: DEFAULT_ELITE_CONFIGURATOR_WIDTH,
    edge: "left",
    key,
    maxWidth: MAX_ELITE_CONFIGURATOR_WIDTH,
    minWidth: MIN_ELITE_CONFIGURATOR_WIDTH,
  });
}

function emitEliteQaEvent(
  event: string,
  details: string,
  context: Record<string, unknown>,
) {
  console.info(
    `QA_EVT ${JSON.stringify({ event, status: "info", details, context })}`,
  );
}

function Reveal({
  children,
  className,
  config,
  index,
  kind = "box",
  replayKey,
}: {
  children: ReactNode;
  className?: string;
  config: EliteRevealConfig;
  index: number;
  kind?: EliteRevealContentKind;
  replayKey: number;
}) {
  return (
    <EliteReveal
      className={className}
      config={config}
      contentKind={kind}
      index={index}
      replayKey={replayKey}
    >
      {children}
    </EliteReveal>
  );
}

function ListFixture({
  config,
  replayKey,
}: {
  config: EliteRevealConfig;
  replayKey: number;
}) {
  return (
    <div className="mx-auto w-full max-w-4xl divide-y border-y">
      {Array.from({ length: viewItemCounts.list }, (_, index) => (
        <Reveal config={config} index={index} key={index} replayKey={replayKey}>
          <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/45">
              {index % 3 === 0 ? (
                <Database className="size-3.5" />
              ) : index % 3 === 1 ? (
                <Radio className="size-3.5" />
              ) : (
                <ShieldCheck className="size-3.5" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-sm font-medium">
                  Relay subsystem {String(index + 1).padStart(2, "0")}
                </p>
                {index % 7 === 0 ? (
                  <Badge variant="secondary">Active</Badge>
                ) : null}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                Signal synchronized · node {1000 + index} · updated moments ago
              </p>
            </div>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {Math.max(4, 98 - (index % 17))}%
            </span>
            <Button
              aria-label={`More options for relay ${index + 1}`}
              size="icon"
              variant="ghost"
            >
              <Ellipsis className="size-4" />
            </Button>
          </div>
        </Reveal>
      ))}
    </div>
  );
}

const cardDescriptions = [
  "Session relay",
  "Repository graph",
  "Agent runtime",
  "Encrypted storage",
  "Terminal service",
  "Desktop stream",
];

function CardsFixture({
  config,
  replayKey,
}: {
  config: EliteRevealConfig;
  replayKey: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: viewItemCounts.cards }, (_, index) => (
        <Reveal config={config} index={index} key={index} replayKey={replayKey}>
          <Card className="h-full gap-4 rounded-lg py-4 shadow-none">
            <CardHeader className="px-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  {index % 2 === 0 ? (
                    <Activity className="size-4" />
                  ) : (
                    <Database className="size-4" />
                  )}
                </div>
                <Badge variant={index % 4 === 0 ? "default" : "outline"}>
                  {index % 4 === 0 ? "Live" : "Standby"}
                </Badge>
              </div>
              <CardTitle className="mt-2 text-sm">
                {cardDescriptions[index % cardDescriptions.length]}
              </CardTitle>
              <CardDescription>
                Channel {String(index + 1).padStart(2, "0")} telemetry and
                control
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-2 px-4 text-xs">
              <div className="rounded-md bg-muted/55 p-2">
                <p className="text-muted-foreground">Latency</p>
                <p className="mt-1 font-mono font-semibold">{12 + index} ms</p>
              </div>
              <div className="rounded-md bg-muted/55 p-2">
                <p className="text-muted-foreground">Packets</p>
                <p className="mt-1 font-mono font-semibold">
                  {184 + index * 7}
                </p>
              </div>
            </CardContent>
          </Card>
        </Reveal>
      ))}
    </div>
  );
}

function TextFixture({
  config,
  replayKey,
}: {
  config: EliteRevealConfig;
  replayKey: number;
}) {
  return (
    <article className="mx-auto grid w-full max-w-3xl gap-7 py-2">
      <Reveal config={config} index={0} kind="text" replayKey={replayKey}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            Cantrip signal laboratory
          </p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight">
            Interface materialization sequence
          </h2>
        </div>
      </Reveal>
      {Array.from({ length: viewItemCounts.text - 2 }, (_, index) => (
        <Reveal
          config={config}
          index={index + 1}
          key={index}
          kind="text"
          replayKey={replayKey}
        >
          <section className="grid gap-2 border-l-2 pl-4">
            <h3 className="text-sm font-semibold">
              {String(index + 1).padStart(2, "0")} / Render telemetry
            </h3>
            <p className="text-sm leading-6 text-muted-foreground">
              This text block exercises multi-line copy, inline emphasis, and
              variable line wrapping. The reveal should feel like a signal
              resolving into a stable interface without making the content
              difficult to read or delaying ordinary navigation.
            </p>
            {index % 3 === 0 ? (
              <blockquote className="rounded-r-md bg-muted/50 px-3 py-2 font-mono text-xs leading-5">
                renderer.status = &quot;synchronized&quot;; // frame{" "}
                {index + 14}
              </blockquote>
            ) : null}
          </section>
        </Reveal>
      ))}
      <Reveal
        config={config}
        index={viewItemCounts.text - 1}
        kind="text"
        replayKey={replayKey}
      >
        <p className="border-t pt-5 text-xs text-muted-foreground">
          End of transmission · all content should now be fully stable.
        </p>
      </Reveal>
    </article>
  );
}

function TableFixture({
  config,
  replayKey,
}: {
  config: EliteRevealConfig;
  replayKey: number;
}) {
  return (
    <div className="min-w-[680px] overflow-hidden rounded-lg border">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="sticky top-0 z-10 bg-muted/95 text-xs text-muted-foreground backdrop-blur">
          <tr>
            <th className="px-3 py-2.5 font-medium">Service</th>
            <th className="px-3 py-2.5 font-medium">Worker</th>
            <th className="px-3 py-2.5 font-medium">State</th>
            <th className="px-3 py-2.5 text-right font-medium">Latency</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {Array.from({ length: viewItemCounts.table }, (_, index) => (
            <tr className="odd:bg-muted/20" key={index}>
              <td className="px-3 py-2.5">
                <Reveal config={config} index={index} replayKey={replayKey}>
                  <div className="flex items-center gap-2 font-medium">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    Surface relay {String(index + 1).padStart(2, "0")}
                  </div>
                </Reveal>
              </td>
              <td className="px-3 py-2.5 text-muted-foreground">
                <Reveal
                  config={config}
                  index={index}
                  kind="text"
                  replayKey={replayKey}
                >
                  <span>cantrip-worker-{(index % 5) + 1}</span>
                </Reveal>
              </td>
              <td className="px-3 py-2.5">
                <Reveal config={config} index={index} replayKey={replayKey}>
                  <Badge variant={index % 6 === 0 ? "secondary" : "outline"}>
                    {index % 6 === 0 ? "Recovering" : "Ready"}
                  </Badge>
                </Reveal>
              </td>
              <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums">
                <Reveal
                  config={config}
                  index={index}
                  kind="text"
                  replayKey={replayKey}
                >
                  <span>{8 + ((index * 7) % 43)} ms</span>
                </Reveal>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WidgetTile({
  children,
  config,
  index,
  replayKey,
  title,
}: {
  children: ReactNode;
  config: EliteRevealConfig;
  index: number;
  replayKey: number;
  title: string;
}) {
  return (
    <Reveal config={config} index={index} kind="control" replayKey={replayKey}>
      <div className="grid min-h-28 gap-3 rounded-lg border bg-card p-4 shadow-xs">
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
        <div className="flex min-w-0 flex-wrap items-center gap-2 self-end">
          {children}
        </div>
      </div>
    </Reveal>
  );
}

function WidgetsFixture({
  config,
  replayKey,
}: {
  config: EliteRevealConfig;
  replayKey: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      <WidgetTile
        config={config}
        index={0}
        replayKey={replayKey}
        title="Buttons"
      >
        <Button size="sm">Primary</Button>
        <Button size="sm" variant="outline">
          Secondary
        </Button>
        <Button size="icon" variant="ghost">
          <Settings2 className="size-4" />
        </Button>
      </WidgetTile>
      <WidgetTile
        config={config}
        index={1}
        replayKey={replayKey}
        title="Text input"
      >
        <Input
          aria-label="Test search"
          className="flex-1"
          placeholder="Search channels…"
        />
        <Button size="icon" variant="outline">
          <Search className="size-4" />
        </Button>
      </WidgetTile>
      <WidgetTile
        config={config}
        index={2}
        replayKey={replayKey}
        title="Select menu"
      >
        <NativeSelect
          aria-label="Signal mode"
          className="w-full"
          defaultValue="adaptive"
        >
          <option value="adaptive">Adaptive signal</option>
          <option value="quality">Maximum quality</option>
          <option value="latency">Low latency</option>
        </NativeSelect>
      </WidgetTile>
      <WidgetTile
        config={config}
        index={3}
        replayKey={replayKey}
        title="Badges"
      >
        <Badge>Connected</Badge>
        <Badge variant="secondary">Queued</Badge>
        <Badge variant="outline">Idle</Badge>
      </WidgetTile>
      <WidgetTile
        config={config}
        index={4}
        replayKey={replayKey}
        title="Range control"
      >
        <input
          aria-label="Signal strength"
          className="w-full accent-foreground"
          defaultValue="68"
          type="range"
        />
        <span className="text-xs text-muted-foreground">68% strength</span>
      </WidgetTile>
      <WidgetTile
        config={config}
        index={5}
        replayKey={replayKey}
        title="Checkboxes"
      >
        <label className="flex items-center gap-2 text-sm">
          <input defaultChecked type="checkbox" /> Encrypted
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" /> Archived
        </label>
      </WidgetTile>
      <WidgetTile
        config={config}
        index={6}
        replayKey={replayKey}
        title="Loading state"
      >
        <LoaderCircle className="size-5 animate-spin" />
        <span className="text-sm">Synchronizing interface…</span>
      </WidgetTile>
      <WidgetTile
        config={config}
        index={7}
        replayKey={replayKey}
        title="Progress"
      >
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full w-[72%] bg-foreground" />
        </div>
        <span className="font-mono text-xs">72 / 100</span>
      </WidgetTile>
      <WidgetTile
        config={config}
        index={8}
        replayKey={replayKey}
        title="Warning state"
      >
        <AlertTriangle className="size-5 text-amber-500" />
        <span className="text-sm">Worker response delayed</span>
      </WidgetTile>
      <WidgetTile
        config={config}
        index={9}
        replayKey={replayKey}
        title="Radio group"
      >
        <label className="flex items-center gap-2 text-sm">
          <input defaultChecked name="elite-radio" type="radio" /> Local
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input name="elite-radio" type="radio" /> Relay
        </label>
      </WidgetTile>
      <WidgetTile
        config={config}
        index={10}
        replayKey={replayKey}
        title="Status metric"
      >
        <p className="text-3xl font-semibold tracking-tight">99.97%</p>
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          Nominal
        </p>
      </WidgetTile>
      <WidgetTile
        config={config}
        index={11}
        replayKey={replayKey}
        title="Skeletons"
      >
        <div className="grid w-full gap-2">
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
          <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
        </div>
      </WidgetTile>
      {Array.from({ length: viewItemCounts.widgets - 12 }, (_, offset) => (
        <WidgetTile
          config={config}
          index={offset + 12}
          key={offset}
          replayKey={replayKey}
          title={`Compact control ${offset + 1}`}
        >
          <Button
            className="flex-1"
            size="sm"
            variant={offset % 2 ? "outline" : "default"}
          >
            Execute {String(offset + 1).padStart(2, "0")}
          </Button>
          <Badge variant="outline">{24 + offset * 3} ms</Badge>
        </WidgetTile>
      ))}
    </div>
  );
}

function NumberOption({
  label,
  maximum,
  minimum,
  onChange,
  suffix,
  value,
}: {
  label: string;
  maximum: number;
  minimum: number;
  onChange(value: number): void;
  suffix?: string;
  value: number;
}) {
  return (
    <label className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-3 text-sm">
      <span>
        {label}
        {suffix ? (
          <span className="ml-1 text-xs text-muted-foreground">({suffix})</span>
        ) : null}
      </span>
      <Input
        max={maximum}
        min={minimum}
        onChange={(event) => onChange(Number(event.target.value))}
        type="number"
        value={value}
      />
    </label>
  );
}

function EliteConfigurator({
  config,
  onApply,
}: {
  config: EliteRevealConfig;
  onApply(config: EliteRevealConfig): void;
}) {
  const [draft, setDraft] = useState<EliteRevealConfig>(() => ({
    ...config,
    variants: [...config.variants],
    variantWeights: { ...config.variantWeights },
  }));
  const configSignature = eliteRevealConfigSignature(config);
  useEffect(() => {
    setDraft({
      ...config,
      variants: [...config.variants],
      variantWeights: { ...config.variantWeights },
    });
  }, [config, configSignature]);

  const setNumber = (
    key:
      "glitchCountMax" | "glitchCountMin" | "glitchShowMs" | "staggerSpreadMs",
    value: number,
  ) => setDraft((current) => ({ ...current, [key]: value }));
  const setVariant = (variant: EliteGlitchVariant, enabled: boolean) =>
    setDraft((current) => ({
      ...current,
      variants: enabled
        ? [...new Set([...current.variants, variant])]
        : current.variants.filter((candidate) => candidate !== variant),
    }));
  const setVariantWeight = (variant: EliteGlitchVariant, weight: number) =>
    setDraft((current) => ({
      ...current,
      variantWeights: {
        ...current.variantWeights,
        [variant]: weight,
      },
    }));

  return (
    <aside
      aria-label="Elite effect options"
      className="flex h-full min-h-0 flex-col border-l bg-background"
    >
      <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="font-semibold">Effect options</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Changes apply together so typing does not continuously replay the
            screen.
          </p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <section className="grid gap-4">
          <div>
            <h3 className="text-sm font-semibold">Timing</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Each item chooses a random glitch count within the range.
            </p>
          </div>
          <NumberOption
            label="Minimum glitches"
            maximum={8}
            minimum={1}
            onChange={(value) => setNumber("glitchCountMin", value)}
            value={draft.glitchCountMin}
          />
          <NumberOption
            label="Maximum glitches"
            maximum={8}
            minimum={1}
            onChange={(value) => setNumber("glitchCountMax", value)}
            value={draft.glitchCountMax}
          />
          <NumberOption
            label="Stagger spread"
            maximum={250}
            minimum={0}
            onChange={(value) => setNumber("staggerSpreadMs", value)}
            suffix="ms"
            value={draft.staggerSpreadMs}
          />
          <p className="text-xs leading-5 text-muted-foreground">
            Visible elements are distributed across this window. Off-screen
            elements still begin by its end.
          </p>
          <NumberOption
            label="Glitch exposure"
            maximum={120}
            minimum={5}
            onChange={(value) => setNumber("glitchShowMs", value)}
            suffix="ms"
            value={draft.glitchShowMs}
          />
        </section>

        <section className="mt-7 grid gap-3 border-t pt-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Variants</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Relative weights control how often each enabled effect is
                selected. Set a weight to zero to suppress it without unchecking
                it. Text jitter is reserved for text wrappers.
              </p>
            </div>
            <div className="flex gap-1">
              <Button
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    variants: ELITE_GLITCH_VARIANTS,
                  }))
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                Check all
              </Button>
              <Button
                onClick={() =>
                  setDraft((current) => ({ ...current, variants: [] }))
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                Check none
              </Button>
            </div>
          </div>
          <div className="grid gap-1">
            {ELITE_GLITCH_VARIANTS.map((variant) => {
              const checked = draft.variants.includes(variant);
              return (
                <div
                  className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted/60"
                  key={variant}
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                    <input
                      checked={checked}
                      onChange={(event) =>
                        setVariant(variant, event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span className="truncate">{variantLabels[variant]}</span>
                  </label>
                  <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <Input
                      aria-label={`${variantLabels[variant]} weight`}
                      className="h-7 w-[4.5rem] px-2 text-right text-xs"
                      max={10}
                      min={0}
                      onChange={(event) =>
                        setVariantWeight(variant, Number(event.target.value))
                      }
                      step={0.05}
                      type="number"
                      value={draft.variantWeights[variant]}
                    />
                    <span aria-hidden="true">×</span>
                  </div>
                  {checked ? (
                    <Check className="size-3.5 text-muted-foreground" />
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      </div>
      <div className="grid grid-cols-2 gap-2 border-t p-4">
        <Button
          onClick={() =>
            setDraft({
              ...DEFAULT_ELITE_REVEAL_CONFIG,
              variants: [...DEFAULT_ELITE_REVEAL_CONFIG.variants],
              variantWeights: {
                ...DEFAULT_ELITE_REVEAL_CONFIG.variantWeights,
              },
            })
          }
          type="button"
          variant="outline"
        >
          Reset defaults
        </Button>
        <Button
          onClick={() => onApply(normalizeEliteRevealConfig(draft))}
          type="button"
        >
          <RefreshCw className="size-4" /> Apply & replay
        </Button>
      </div>
    </aside>
  );
}

function EliteConfiguratorSidebar({
  children,
  open,
}: {
  children: ReactNode;
  open: boolean;
}) {
  return (
    <ResizablePanel
      ariaLabel="Resize Elite effect options sidebar"
      defaultWidth={DEFAULT_ELITE_CONFIGURATOR_WIDTH}
      handleDataSlot="elite-configurator-resize-handle"
      maxWidth={MAX_ELITE_CONFIGURATOR_WIDTH}
      minWidth={MIN_ELITE_CONFIGURATOR_WIDTH}
      open={open}
      shellDataSlot="elite-configurator-sidebar-shell"
      storageKey={ELITE_CONFIGURATOR_WIDTH_STORAGE_KEY}
      surfaceDataSlot="elite-configurator-sidebar-surface"
      title="Drag to resize Elite effect options sidebar"
    >
      {children}
    </ResizablePanel>
  );
}

export function EliteSettings({
  appWideEnabled = false,
  configSaving = false,
  configuredEffect = DEFAULT_ELITE_REVEAL_CONFIG,
  onAppWideEnabledChange,
  onConfigChange,
  saveError = null,
}: {
  appWideEnabled?: boolean;
  configSaving?: boolean;
  configuredEffect?: EliteRevealConfig;
  onAppWideEnabledChange?(enabled: boolean): void;
  onConfigChange?(config: EliteRevealConfig): void;
  saveError?: string | null;
}) {
  const [view, setView] = useState<EliteLabView>("list");
  const [config, setConfig] = useState<EliteRevealConfig>(() => ({
    ...configuredEffect,
    variants: [...configuredEffect.variants],
    variantWeights: { ...configuredEffect.variantWeights },
  }));
  const [replayKey, setReplayKey] = useState(0);
  const [configuratorOpen, setConfiguratorOpen] = useState(false);
  const enabledVariantSummary = useMemo(
    () =>
      config.variants.length === ELITE_GLITCH_VARIANTS.length
        ? "all variants"
        : `${config.variants.length} variant${config.variants.length === 1 ? "" : "s"}`,
    [config.variants],
  );

  useEffect(() => {
    emitEliteQaEvent("elite_lab_loaded", "Elite visual QA lab mounted", {
      view,
    });
  }, []);

  const configuredEffectSignature =
    eliteRevealConfigSignature(configuredEffect);
  useEffect(() => {
    setConfig({
      ...configuredEffect,
      variants: [...configuredEffect.variants],
      variantWeights: { ...configuredEffect.variantWeights },
    });
  }, [configuredEffect, configuredEffectSignature]);

  const replay = (nextConfig = config, source = "toolbar") => {
    setReplayKey((current) => current + 1);
    emitEliteQaEvent("elite_reveal_replayed", "Reveal sequence replayed", {
      config: nextConfig,
      itemCount: viewItemCounts[view],
      source,
      view,
    });
  };
  const changeView = (nextView: EliteLabView) => {
    setView(nextView);
    setReplayKey((current) => current + 1);
    emitEliteQaEvent("elite_lab_view_changed", "Fixture view changed", {
      itemCount: viewItemCounts[nextView],
      view: nextView,
    });
  };

  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 overflow-hidden rounded-lg border bg-background"
      data-elite-lab=""
    >
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="shrink-0 border-b bg-background/95 px-3 pt-3 backdrop-blur sm:px-4">
          <div className="flex flex-wrap items-start justify-between gap-3 pb-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Activity className="size-4" />
                <h1 className="font-semibold">Elite reveal laboratory</h1>
                <Badge variant="outline">Experimental</Badge>
              </div>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                Materialization effects for explicit text, box, and control
                boundaries. Replays run across the full fixture, including
                off-screen items. Saved options can run app-wide while this lab
                stays isolated for accurate previews.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <Button
                aria-checked={appWideEnabled}
                disabled={configSaving}
                onClick={() => onAppWideEnabledChange?.(!appWideEnabled)}
                role="switch"
                size="sm"
                type="button"
                variant={appWideEnabled ? "default" : "outline"}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 rounded-full",
                    appWideEnabled ? "bg-background" : "bg-muted-foreground",
                  )}
                />
                App-wide {appWideEnabled ? "on" : "off"}
              </Button>
              <Button onClick={() => replay()} size="sm" variant="outline">
                <RefreshCw className="size-3.5" /> Replay
              </Button>
              <Button
                aria-pressed={configuratorOpen}
                onClick={() => setConfiguratorOpen((current) => !current)}
                size="sm"
              >
                {configuratorOpen ? (
                  <PanelRightClose className="size-3.5" />
                ) : (
                  <PanelRightOpen className="size-3.5" />
                )}
                Configure
              </Button>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-end justify-between gap-2">
            <NavigationTabBar
              activeTab={view}
              ariaLabel="Elite laboratory views"
              onTabChange={changeView}
              tabs={eliteLabTabs}
            />
            <p className="pb-2 text-[11px] text-muted-foreground">
              {config.glitchCountMin}–{config.glitchCountMax} glitches ·{" "}
              {config.glitchShowMs} ms · {config.staggerSpreadMs} ms spread ·{" "}
              {enabledVariantSummary}
            </p>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto overscroll-contain p-3 sm:p-5">
          {view === "list" ? (
            <ListFixture config={config} replayKey={replayKey} />
          ) : null}
          {view === "cards" ? (
            <CardsFixture config={config} replayKey={replayKey} />
          ) : null}
          {view === "text" ? (
            <TextFixture config={config} replayKey={replayKey} />
          ) : null}
          {view === "table" ? (
            <TableFixture config={config} replayKey={replayKey} />
          ) : null}
          {view === "widgets" ? (
            <WidgetsFixture config={config} replayKey={replayKey} />
          ) : null}
        </div>

        <div className="shrink-0 border-t bg-muted/25 px-4 py-2 text-[11px] text-muted-foreground">
          React component types are not reliably inspectable after composition.
          This lab uses explicit semantic roles; DOM type traversal is possible,
          but intentionally avoided because it is brittle.
          {saveError ? (
            <span className="ml-2 text-destructive">{saveError}</span>
          ) : null}
        </div>
      </div>
      <EliteConfiguratorSidebar open={configuratorOpen}>
        <EliteConfigurator
          config={config}
          onApply={(nextConfig) => {
            setConfig(nextConfig);
            replay(nextConfig, "configurator");
            onConfigChange?.(nextConfig);
          }}
        />
      </EliteConfiguratorSidebar>
    </div>
  );
}

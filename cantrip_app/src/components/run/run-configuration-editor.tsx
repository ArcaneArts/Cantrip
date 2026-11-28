import {
  useRunDefinitionApi,
  useRunDefinitionScope,
} from "@/lib/run-definition-source";
import {
  runConfigurationSecretReferenceSchema,
  type RunConfigurationDetectionCandidate,
  type RunConfigurationDartDocument,
  type RunConfigurationFile,
  type RunConfigurationFlutterDocument,
  type RunConfigurationJavaDocument,
  type RunConfigurationNodeDocument,
  type RunConfigurationPathPurpose,
  type RunConfigurationProviderCapability,
  type RunConfigurationProviderKind,
  type RunConfigurationProviderValidation,
  type RunConfigurationRepositoryEntry,
  type RunConfigurationRustDocument,
  type RunConfigurationShellDocument,
} from "@cantrip/protocol/run-configuration-definitions";
import type { RunConfigurationSecretSummary } from "@cantrip/protocol/run-configuration-secrets";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Boxes,
  Coffee,
  FileCode2,
  KeyRound,
  Loader2,
  Package,
  Plus,
  Smartphone,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Input } from "@/components/ui/input";
import { NavigationTabBar } from "@/components/ui/navigation-tab-bar";
import { NativeSelect } from "@/components/ui/native-select";
import { RunConfigurationFlutterDevicePicker } from "@/components/run/run-configuration-flutter-device-picker";
import { RunConfigurationPathPicker } from "@/components/run/run-configuration-path-picker";
import { RunConfigurationTargetPicker } from "@/components/run/run-configuration-target-picker";
import { RunConfigurationValidationStatus } from "@/components/run/run-configuration-validation-status";
import {
  listRunConfigurationSecrets,
  setRunConfigurationSecret,
} from "@/lib/run-configuration-api";
import {
  applyRunConfigurationDetectionCandidate,
  createRunConfigurationDocument,
  createShellRunConfigurationDocument,
  parseRunConfigurationEditorDocument,
  runConfigurationEffectiveCommand,
  runConfigurationTargetLabel,
} from "@/lib/run-configuration-editor-model";
import { cn } from "@/lib/utils";

const fieldClassName = "grid gap-1.5 text-sm";
const labelClassName = "text-xs font-medium text-muted-foreground";
const textareaClassName =
  "min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

const configurationTabs = [
  { id: "command", label: "Command" },
  { id: "environment", label: "Environment" },
  { id: "lifecycle", label: "Lifecycle" },
] as const;
type ConfigurationTab = (typeof configurationTabs)[number]["id"];

function issueTab(field: string): ConfigurationTab {
  const root = field.split(".")[0];
  if (root === "environment") return "environment";
  if (
    root === "beforeLaunch" ||
    root === "options" ||
    root === "stop" ||
    root === "platformOverrides"
  ) {
    return "lifecycle";
  }
  return "command";
}

function FieldErrors({ id, messages }: { id?: string; messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <div className="grid gap-1 text-xs text-destructive" id={id} role="alert">
      {[...new Set(messages)].map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  );
}

type RunConfigurationEditorPatch = {
  [Field in keyof RunConfigurationFile]?: RunConfigurationFile[Field];
};

function unknownRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function documentSecretReferences(
  document: RunConfigurationFile,
  platformOverrides: string,
): string[] {
  const references = new Set<string>();
  const add = (candidate: string) => {
    const parsed = runConfigurationSecretReferenceSchema.safeParse(candidate);
    if (parsed.success) references.add(parsed.data);
  };
  document.environment.secrets.forEach(({ secret }) => add(secret));
  try {
    const overrides = unknownRecord(JSON.parse(platformOverrides));
    Object.values(overrides ?? {}).forEach((override) => {
      const environment = unknownRecord(unknownRecord(override)?.environment);
      const secrets = environment?.secrets;
      if (!Array.isArray(secrets)) return;
      secrets.forEach((secret) => {
        const reference = unknownRecord(secret)?.secret;
        if (typeof reference === "string") add(reference);
      });
    });
  } catch {
    // Invalid override JSON is reported by the normal editor validation.
  }
  return [...references].sort((left, right) => left.localeCompare(right));
}

function StringListEditor({
  addLabel,
  pathPicker,
  values,
  onChange,
}: {
  addLabel: string;
  pathPicker?: {
    ariaLabel: string;
    projectId: string;
    purpose: RunConfigurationPathPurpose;
  };
  values: string[];
  onChange(values: string[]): void;
}) {
  return (
    <div className="grid gap-2">
      {values.map((value, index) => (
        <div className="flex gap-2" key={index}>
          <Input
            className="min-w-0 flex-1"
            aria-label={`${addLabel} ${index + 1}`}
            value={value}
            onChange={(event) =>
              onChange(
                values.map((item, itemIndex) =>
                  itemIndex === index ? event.target.value : item,
                ),
              )
            }
          />
          {pathPicker ? (
            <RunConfigurationPathPicker
              ariaLabel={`${pathPicker.ariaLabel} ${index + 1}`}
              currentPath={value}
              onChoose={(path) =>
                onChange(
                  values.map((item, itemIndex) =>
                    itemIndex === index ? path : item,
                  ),
                )
              }
              projectId={pathPicker.projectId}
              purpose={pathPicker.purpose}
            />
          ) : null}
          <Button
            aria-label={`Remove ${addLabel.toLocaleLowerCase()} ${index + 1}`}
            onClick={() =>
              onChange(values.filter((_, itemIndex) => itemIndex !== index))
            }
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        className="w-fit"
        onClick={() => onChange([...values, ""])}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="size-3.5" /> {addLabel}
      </Button>
    </div>
  );
}

function EnvironmentRows({
  kind,
  rows,
  secretReferences = [],
  onChange,
}: {
  kind: "variable" | "secret";
  rows: Array<{ name: string; value: string; enabled: boolean }>;
  secretReferences?: string[];
  onChange(
    rows: Array<{ name: string; value: string; enabled: boolean }>,
  ): void;
}) {
  return (
    <div className="grid gap-2">
      {rows.map((row, index) => (
        <div
          className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-2"
          key={index}
        >
          <input
            aria-label={`Enable ${kind} ${index + 1}`}
            checked={row.enabled}
            onChange={(event) =>
              onChange(
                rows.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, enabled: event.target.checked }
                    : item,
                ),
              )
            }
            type="checkbox"
          />
          <Input
            aria-label={`${kind} name ${index + 1}`}
            placeholder="NAME"
            value={row.name}
            onChange={(event) =>
              onChange(
                rows.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, name: event.target.value }
                    : item,
                ),
              )
            }
          />
          <Input
            aria-label={`${kind} value ${index + 1}`}
            list={
              kind === "secret"
                ? "run-configuration-secret-references"
                : undefined
            }
            placeholder={kind === "secret" ? "vault/reference" : "Value"}
            value={row.value}
            onChange={(event) =>
              onChange(
                rows.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, value: event.target.value }
                    : item,
                ),
              )
            }
          />
          <Button
            aria-label={`Remove ${kind} ${index + 1}`}
            onClick={() =>
              onChange(rows.filter((_, itemIndex) => itemIndex !== index))
            }
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      {kind === "secret" ? (
        <datalist id="run-configuration-secret-references">
          {secretReferences.map((reference) => (
            <option key={reference} value={reference} />
          ))}
        </datalist>
      ) : null}
      <Button
        className="w-fit"
        onClick={() =>
          onChange([...rows, { name: "", value: "", enabled: true }])
        }
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="size-3.5" /> Add {kind}
      </Button>
    </div>
  );
}

function SecretValueEditor({
  reference,
  summary,
  projectId,
  onSaved,
}: {
  reference: string;
  summary: RunConfigurationSecretSummary | null;
  projectId: string;
  onSaved(summary: RunConfigurationSecretSummary): void;
}) {
  const [value, setValue] = useState("");
  const mutation = useMutation({
    mutationFn: () => setRunConfigurationSecret(projectId, reference, value),
    onSuccess: (result) => {
      setValue("");
      onSaved(result.secret);
    },
  });

  return (
    <div className="grid gap-2 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="size-3.5 shrink-0" />
            <code className="truncate">{reference}</code>
          </div>
          <p className="text-xs text-muted-foreground">
            {summary?.available
              ? `Configured · revision ${summary.revision}`
              : "Missing · set a value before running"}
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <Input
          aria-label={`Write-only value for ${reference}`}
          autoComplete="new-password"
          onChange={(event) => setValue(event.target.value)}
          placeholder="Write-only secret value"
          type="password"
          value={value}
        />
        <Button
          disabled={value.length === 0 || mutation.isPending}
          onClick={() => mutation.mutate()}
          type="button"
          variant="outline"
        >
          {mutation.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : null}
          {summary?.available ? "Rotate value" : "Set value"}
        </Button>
      </div>
      {mutation.error ? (
        <p className="text-xs text-destructive" role="alert">
          {mutation.error instanceof Error
            ? mutation.error.message
            : "The secret value could not be stored."}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Values are encrypted locally and cannot be revealed from this editor.
      </p>
    </div>
  );
}

function DartDefineRows({
  rows,
  onChange,
}: {
  rows: Array<{ name: string; value: string }>;
  onChange(rows: Array<{ name: string; value: string }>): void;
}) {
  return (
    <div className="grid gap-2">
      {rows.map((row, index) => (
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2" key={index}>
          <Input
            aria-label={`Dart define name ${index + 1}`}
            placeholder="NAME"
            value={row.name}
            onChange={(event) =>
              onChange(
                rows.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, name: event.target.value }
                    : item,
                ),
              )
            }
          />
          <Input
            aria-label={`Dart define value ${index + 1}`}
            placeholder="Value"
            value={row.value}
            onChange={(event) =>
              onChange(
                rows.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, value: event.target.value }
                    : item,
                ),
              )
            }
          />
          <Button
            aria-label={`Remove Dart define ${index + 1}`}
            onClick={() =>
              onChange(rows.filter((_, itemIndex) => itemIndex !== index))
            }
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        className="w-fit"
        onClick={() => onChange([...rows, { name: "", value: "" }])}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="size-3.5" /> Add Dart define
      </Button>
    </div>
  );
}

function initialDocument(entry: RunConfigurationRepositoryEntry | null) {
  return entry?.status === "ready" && entry.document
    ? entry.document
    : createShellRunConfigurationDocument();
}

function ProviderGlyph({
  provider,
}: {
  provider: RunConfigurationProviderKind;
}) {
  if (provider === "node") return <Package className="size-5" />;
  if (provider === "java") return <Coffee className="size-5" />;
  if (provider === "dart") return <FileCode2 className="size-5" />;
  if (provider === "flutter") return <Smartphone className="size-5" />;
  if (provider === "rust") return <Boxes className="size-5" />;
  return <Terminal className="size-5" />;
}

function RunConfigurationCreationChooser({
  destinationLabel,
  candidates,
  capabilities,
  diagnostics,
  error,
  loading,
  onCancel,
  onChooseCandidate,
  onChooseProvider,
}: {
  destinationLabel?: string;
  candidates: RunConfigurationDetectionCandidate[];
  capabilities: RunConfigurationProviderCapability[];
  diagnostics: string[];
  error: Error | null;
  loading: boolean;
  onCancel(): void;
  onChooseCandidate(candidate: RunConfigurationDetectionCandidate): void;
  onChooseProvider(
    provider: "dart" | "flutter" | "java" | "node" | "rust" | "shell",
  ): void;
}) {
  const highConfidence = candidates.filter(
    ({ confidence }) => confidence === "high",
  );
  const recommendedId =
    highConfidence.length === 1 ? highConfidence[0]!.document.id : null;
  const available = capabilities.filter(
    (
      capability,
    ): capability is RunConfigurationProviderCapability & {
      provider: "dart" | "flutter" | "java" | "node" | "rust" | "shell";
    } =>
      capability.available &&
      (capability.provider === "dart" ||
        capability.provider === "flutter" ||
        capability.provider === "java" ||
        capability.provider === "node" ||
        capability.provider === "rust" ||
        capability.provider === "shell"),
  );
  return (
    <DialogContent aria-describedby={undefined} className="max-w-3xl gap-4">
      <DialogHeader>
        <DialogTitle>New Run configuration</DialogTitle>
        {destinationLabel ? (
          <DialogDescription>{destinationLabel}</DialogDescription>
        ) : null}
      </DialogHeader>
      {loading ? (
        <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Detecting project targets…
        </div>
      ) : (
        <div className="grid gap-5">
          <section className="grid gap-3">
            <h3 className="font-medium">Detected targets</h3>
            {candidates.length ? (
              <Command className="rounded-lg border">
                <CommandInput placeholder="Search detected targets…" />
                <CommandList className="max-h-72">
                  <CommandEmpty>No matching detected targets.</CommandEmpty>
                  <CommandGroup>
                    {candidates.map((candidate) => (
                      <CommandItem
                        className="grid gap-2 border-b p-3 last:border-b-0"
                        key={candidate.document.id}
                        onSelect={() => onChooseCandidate(candidate)}
                        value={`${candidate.document.name} ${candidate.provider} ${candidate.effectiveCommand} ${candidate.reason}`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <ProviderGlyph provider={candidate.provider} />
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {candidate.document.name}
                          </span>
                          {candidate.document.id === recommendedId ? (
                            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                              Recommended
                            </span>
                          ) : (
                            <span className="text-[10px] uppercase text-muted-foreground">
                              {candidate.confidence}
                            </span>
                          )}
                        </div>
                        <code className="truncate text-xs">
                          {candidate.effectiveCommand}
                        </code>
                        <span className="text-xs text-muted-foreground">
                          {candidate.reason}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            ) : (
              <p className="text-sm text-muted-foreground">
                No project targets found.
              </p>
            )}
          </section>
          <section className="grid gap-3">
            <h3 className="font-medium">Configuration type</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {available.map((capability) => (
                <button
                  className="flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-ring hover:bg-muted/40"
                  key={capability.provider}
                  onClick={() => onChooseProvider(capability.provider)}
                  type="button"
                >
                  <ProviderGlyph provider={capability.provider} />
                  <span>
                    <span className="block font-medium">
                      {capability.label}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {capability.provider === "shell"
                        ? "Blank command or script"
                        : capability.provider === "node"
                          ? "Package script or Node entrypoint"
                          : capability.provider === "java"
                            ? "Gradle or Maven application"
                            : capability.provider === "dart"
                              ? "Dart package entrypoint"
                              : capability.provider === "flutter"
                                ? "Flutter app entrypoint and device"
                                : "Cargo binary or example"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
          {diagnostics.length ? (
            <InlineAlert tone="warning" title="Detection notes">
              {diagnostics.join(" ")}
            </InlineAlert>
          ) : null}
          {error ? <InlineAlert error={error} tone="error" /> : null}
        </div>
      )}
      <DialogFooter>
        <Button onClick={onCancel} type="button" variant="outline">
          Cancel
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function JavaTargetEditor({
  document,
  projectId,
  onChange,
}: {
  document: RunConfigurationJavaDocument;
  projectId: string;
  onChange(document: RunConfigurationJavaDocument): void;
}) {
  const target = document.target;
  const gradle =
    target.kind === "gradleTask" || target.kind === "gradleMainClass";
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className={fieldClassName}>
        <span className={labelClassName}>
          {gradle ? "Gradle project" : "Maven module (optional)"}
        </span>
        <div className="flex gap-2">
          <Input
            aria-label={gradle ? "Gradle project" : "Maven module"}
            className="min-w-0 flex-1 font-mono"
            placeholder={gradle ? ":app" : ":api or services/api"}
            value={gradle ? target.projectPath : (target.module ?? "")}
            onChange={(event) =>
              onChange({
                ...document,
                target: gradle
                  ? { ...target, projectPath: event.target.value }
                  : { ...target, module: event.target.value || null },
              } as RunConfigurationJavaDocument)
            }
          />
          {!gradle ? (
            <RunConfigurationPathPicker
              ariaLabel="Browse Maven module directories"
              currentPath={target.module ?? "."}
              onChoose={(path) =>
                onChange({
                  ...document,
                  target: { ...target, module: path === "." ? null : path },
                })
              }
              projectId={projectId}
              purpose="directory"
            />
          ) : null}
        </div>
      </div>
      <label className={fieldClassName}>
        <span className={labelClassName}>
          {target.kind === "gradleTask"
            ? "Gradle task"
            : target.kind === "mavenGoal"
              ? "Maven goal"
              : "Main class"}
        </span>
        <Input
          className="font-mono"
          placeholder={
            target.kind === "gradleTask"
              ? "run"
              : target.kind === "mavenGoal"
                ? "spring-boot:run"
                : "com.example.Application"
          }
          value={
            target.kind === "gradleTask"
              ? target.task
              : target.kind === "mavenGoal"
                ? target.goal
                : target.className
          }
          onChange={(event) =>
            onChange({
              ...document,
              target:
                target.kind === "gradleTask"
                  ? { ...target, task: event.target.value }
                  : target.kind === "mavenGoal"
                    ? { ...target, goal: event.target.value }
                    : { ...target, className: event.target.value },
            })
          }
        />
      </label>
    </div>
  );
}

function DartTargetEditor({
  document,
  projectId,
  onChange,
}: {
  document: RunConfigurationDartDocument;
  projectId: string;
  onChange(document: RunConfigurationDartDocument): void;
}) {
  return (
    <div className={fieldClassName}>
      <span className={labelClassName}>Dart entrypoint</span>
      <div className="flex gap-2">
        <Input
          aria-label="Dart entrypoint"
          className="min-w-0 flex-1 font-mono"
          placeholder="bin/server.dart"
          value={document.target.path}
          onChange={(event) =>
            onChange({
              ...document,
              target: { kind: "entrypoint", path: event.target.value },
            })
          }
        />
        <RunConfigurationPathPicker
          ariaLabel="Browse Dart entrypoints"
          currentPath={document.target.path}
          onChoose={(path) =>
            onChange({
              ...document,
              target: { kind: "entrypoint", path },
            })
          }
          projectId={projectId}
          purpose="file"
        />
      </div>
    </div>
  );
}

function FlutterTargetEditor({
  document,
  projectId,
  onChange,
}: {
  document: RunConfigurationFlutterDocument;
  projectId: string;
  onChange(document: RunConfigurationFlutterDocument): void;
}) {
  return (
    <div className={fieldClassName}>
      <span className={labelClassName}>Flutter entrypoint</span>
      <div className="flex gap-2">
        <Input
          aria-label="Flutter entrypoint"
          className="min-w-0 flex-1 font-mono"
          placeholder="lib/main.dart"
          value={document.target.path}
          onChange={(event) =>
            onChange({
              ...document,
              target: { kind: "entrypoint", path: event.target.value },
            })
          }
        />
        <RunConfigurationPathPicker
          ariaLabel="Browse Flutter entrypoints"
          currentPath={document.target.path}
          onChoose={(path) =>
            onChange({
              ...document,
              target: { kind: "entrypoint", path },
            })
          }
          projectId={projectId}
          purpose="file"
        />
      </div>
    </div>
  );
}

function RustTargetEditor({
  document,
  onChange,
}: {
  document: RunConfigurationRustDocument;
  onChange(document: RunConfigurationRustDocument): void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className={fieldClassName}>
        <span className={labelClassName}>Cargo package</span>
        <Input
          className="font-mono"
          placeholder="api"
          value={document.target.package}
          onChange={(event) =>
            onChange({
              ...document,
              target: { ...document.target, package: event.target.value },
            })
          }
        />
      </label>
      <label className={fieldClassName}>
        <span className={labelClassName}>
          {document.target.kind === "binary" ? "Binary" : "Example"} target
        </span>
        <Input
          className="font-mono"
          placeholder={
            document.target.kind === "binary" ? "api-server" : "quickstart"
          }
          value={document.target.name}
          onChange={(event) =>
            onChange({
              ...document,
              target: { ...document.target, name: event.target.value },
            })
          }
        />
      </label>
    </div>
  );
}

export function RunConfigurationEditor({
  destinationLabel,
  creating,
  entry,
  open,
  projectId,
  onOpenChange,
  onSaved,
}: {
  destinationLabel?: string;
  creating: boolean;
  entry: RunConfigurationRepositoryEntry | null;
  open: boolean;
  projectId: string;
  onOpenChange(open: boolean): void;
  onSaved(entry: RunConfigurationRepositoryEntry): void;
}) {
  const [document, setDocument] = useState<RunConfigurationFile>(() =>
    initialDocument(entry),
  );
  const [stage, setStage] = useState<"choose" | "edit">(
    creating ? "choose" : "edit",
  );
  const editorId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [tab, setTab] = useState<ConfigurationTab>("command");
  const [touchedFields, setTouchedFields] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [expectedRevision, setExpectedRevision] = useState<string | null>(
    entry?.revision ?? null,
  );
  const [platformOverrides, setPlatformOverrides] = useState(() =>
    JSON.stringify(initialDocument(entry).platformOverrides, null, 2),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [conflictRevision, setConflictRevision] = useState<string | null>(null);
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const [validationDraft, setValidationDraft] = useState<{
    document: RunConfigurationFile;
    fingerprint: string;
  } | null>(null);
  const queryClient = useQueryClient();
  const {
    detectRunConfigurations,
    getRunConfigurationCapabilities,
    saveRunConfiguration,
    validateRunConfiguration,
  } = useRunDefinitionApi();
  const runSourceScope = useRunDefinitionScope();
  const editingRevision = entry?.revision ?? null;
  const detection = useQuery({
    enabled: open && creating && stage === "choose",
    queryKey: ["run-configuration-detection", projectId, runSourceScope],
    queryFn: () => detectRunConfigurations(projectId),
    staleTime: 5_000,
  });
  const capabilities = useQuery({
    enabled: open && creating && stage === "choose",
    queryKey: ["run-configuration-capabilities", projectId, runSourceScope],
    queryFn: () => getRunConfigurationCapabilities(projectId),
    staleTime: 30_000,
  });
  const targetDetection = useQuery({
    enabled:
      open &&
      stage === "edit" &&
      targetPickerOpen &&
      document.provider !== "shell",
    queryKey: [
      "run-configuration-target-detection",
      projectId,
      runSourceScope,
      document.provider,
    ],
    queryFn: () => detectRunConfigurations(projectId, document.provider),
    staleTime: 5_000,
  });
  const secretQueryKey = ["run-configuration-secrets", projectId] as const;
  const storedSecrets = useQuery({
    enabled: open && stage === "edit",
    queryKey: secretQueryKey,
    queryFn: () => listRunConfigurationSecrets(projectId),
    staleTime: 5_000,
  });
  const referencedSecrets = useMemo(
    () => documentSecretReferences(document, platformOverrides),
    [document, platformOverrides],
  );
  const suggestedSecretReferences = useMemo(
    () =>
      [
        ...new Set([
          ...referencedSecrets,
          ...(storedSecrets.data?.map(({ reference }) => reference) ?? []),
        ]),
      ].sort((left, right) => left.localeCompare(right)),
    [referencedSecrets, storedSecrets.data],
  );
  const secretSummaries = useMemo(
    () =>
      new Map(
        storedSecrets.data?.map((summary) => [summary.reference, summary]) ??
          [],
      ),
    [storedSecrets.data],
  );
  const parsedDraft = useMemo(
    () => parseRunConfigurationEditorDocument(document, platformOverrides),
    [document, platformOverrides],
  );
  const draftFingerprint = parsedDraft.success
    ? JSON.stringify(parsedDraft.document)
    : null;
  const issues = parsedDraft.success ? [] : parsedDraft.issues;
  const touchField = (field: string) =>
    setTouchedFields((current) =>
      current.has(field) ? current : new Set([...current, field]),
    );
  const fieldErrors = (field: string) =>
    attemptedSave || touchedFields.has(field)
      ? issues
          .filter(
            (issue) =>
              issue.field === field || issue.field.startsWith(`${field}.`),
          )
          .map(({ message }) => message)
      : [];
  const resetFormView = () => {
    setTab("command");
    setAttemptedSave(false);
    setTouchedFields(new Set());
  };
  const selectTab = (next: ConfigurationTab) => {
    setTab(next);
    if (next !== tab) formRef.current?.scrollTo(0, 0);
  };
  const showFirstIssue = () => {
    const firstInvalidTab = configurationTabs.find(({ id }) =>
      issues.some(({ field }) => issueTab(field) === id),
    );
    if (firstInvalidTab) selectTab(firstInvalidTab.id);
    setAttemptedSave(true);
  };

  useEffect(() => {
    if (
      !open ||
      stage !== "edit" ||
      !parsedDraft.success ||
      !draftFingerprint
    ) {
      setValidationDraft(null);
      return;
    }
    const timeout = window.setTimeout(() => {
      setValidationDraft({
        document: parsedDraft.document,
        fingerprint: draftFingerprint,
      });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [draftFingerprint, open, parsedDraft, stage]);

  const providerValidation = useQuery({
    enabled: validationDraft !== null,
    queryKey: [
      "run-configuration-provider-validation",
      projectId,
      runSourceScope,
      validationDraft?.fingerprint,
    ],
    queryFn: () => {
      if (!validationDraft) {
        throw new Error("No Run configuration draft is ready to validate.");
      }
      return validateRunConfiguration(projectId, validationDraft.document);
    },
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const validationIsCurrent =
    validationDraft !== null &&
    validationDraft.fingerprint === draftFingerprint;
  const currentValidation: RunConfigurationProviderValidation | null =
    validationIsCurrent ? (providerValidation.data ?? null) : null;
  const updateSecretSummary = (summary: RunConfigurationSecretSummary) => {
    queryClient.setQueryData<RunConfigurationSecretSummary[]>(
      secretQueryKey,
      (current = []) =>
        [
          ...current.filter(({ reference }) => reference !== summary.reference),
          summary,
        ].sort((left, right) => left.reference.localeCompare(right.reference)),
    );
  };

  const reload = () => {
    const next = initialDocument(entry);
    setDocument(next);
    setExpectedRevision(entry?.revision ?? null);
    setPlatformOverrides(JSON.stringify(next.platformOverrides, null, 2));
    setErrors([]);
    setConflictRevision(null);
    setTargetPickerOpen(false);
    setValidationDraft(null);
    resetFormView();
    setStage(creating ? "choose" : "edit");
  };

  useEffect(() => {
    if (open) reload();
    // A newly opened dialog intentionally snapshots the latest prop revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const externallyDeleted = open && !creating && entry === null;
  const externallyChanged =
    !externallyDeleted &&
    open &&
    expectedRevision !== null &&
    editingRevision !== expectedRevision;
  const supportsProviderTask =
    document.provider === "node" ||
    document.provider === "java" ||
    document.provider === "flutter" ||
    document.provider === "rust";
  const effective = useMemo(
    () => runConfigurationEffectiveCommand(document),
    [document],
  );
  const effectiveCommand =
    currentValidation?.effectiveCommand ?? effective.command;
  const save = useMutation({
    mutationFn: async (overwriteRevision?: string) => {
      if (!parsedDraft.success) {
        showFirstIssue();
        return null;
      }
      setErrors([]);
      return saveRunConfiguration(projectId, {
        expectedRevision: overwriteRevision ?? expectedRevision,
        document: parsedDraft.document,
      });
    },
    onSuccess: (result) => {
      if (!result) return;
      if ("entry" in result) {
        onSaved(result.entry);
        onOpenChange(false);
        return;
      }
      if (result.outcome === "revision-mismatch") {
        setConflictRevision(result.currentRevision);
        setErrors([
          "This configuration changed outside the editor. Reload it or explicitly overwrite the latest revision.",
        ]);
      } else if (result.outcome === "name-conflict") {
        setErrors(["Another Run configuration already uses this name."]);
      } else if (result.outcome === "already-exists") {
        setErrors([
          "A configuration with this ID already exists. Close and create it again.",
        ]);
      } else {
        setErrors([
          "This Run configuration no longer exists. Reload the inventory.",
        ]);
      }
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(undefined);
  };
  const patchDocument = (patch: RunConfigurationEditorPatch) =>
    setDocument(
      (current) => ({ ...current, ...patch }) as RunConfigurationFile,
    );
  const chooseDocument = (next: RunConfigurationFile) => {
    setDocument(next);
    setExpectedRevision(null);
    setPlatformOverrides(JSON.stringify(next.platformOverrides, null, 2));
    setErrors([]);
    setConflictRevision(null);
    setTargetPickerOpen(false);
    setValidationDraft(null);
    resetFormView();
    setStage("edit");
  };

  if (creating && stage === "choose") {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <RunConfigurationCreationChooser
          destinationLabel={destinationLabel}
          candidates={detection.data?.candidates ?? []}
          capabilities={capabilities.data ?? []}
          diagnostics={
            detection.data?.diagnostics.map(({ message }) => message) ?? []
          }
          error={detection.error ?? capabilities.error ?? null}
          loading={detection.isLoading || capabilities.isLoading}
          onCancel={() => onOpenChange(false)}
          onChooseCandidate={(candidate) =>
            chooseDocument({
              ...candidate.document,
              id: crypto.randomUUID(),
            } as RunConfigurationFile)
          }
          onChooseProvider={(provider) =>
            chooseDocument(createRunConfigurationDocument(provider))
          }
        />
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[min(34rem,calc(100svh-2rem))] max-w-2xl flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            {creating ? (
              <Button
                aria-label="Choose another Run configuration type"
                onClick={() => setStage("choose")}
                size="icon"
                type="button"
                variant="ghost"
              >
                <ArrowLeft className="size-4" />
              </Button>
            ) : null}
            <DialogTitle>
              {entry ? "Edit Run configuration" : "New Run configuration"}
            </DialogTitle>
          </div>
        </DialogHeader>
        <NavigationTabBar
          activeTab={tab}
          ariaLabel="Run configuration settings"
          className="border-b px-4 sm:px-6"
          onTabChange={selectTab}
          panelIdPrefix={editorId}
          tabs={configurationTabs.map((item) => ({
            ...item,
            attention:
              attemptedSave &&
              issues.some(({ field }) => issueTab(field) === item.id),
          }))}
        />
        <form
          className="grid min-h-0 min-w-0 flex-1 content-start gap-4 overflow-y-auto px-4 py-4 sm:px-6"
          id={`${editorId}-form`}
          noValidate
          ref={formRef}
          onSubmit={submit}
        >
          {externallyDeleted ? (
            <InlineAlert tone="error" title="The shared file was deleted">
              Close this editor and create a new Run configuration if you want
              to replace it. Saving this stale draft is disabled.
            </InlineAlert>
          ) : externallyChanged ? (
            <InlineAlert tone="warning" title="The shared file changed">
              Reload to use revision {editingRevision?.slice(0, 8)}, or keep
              editing and resolve the conflict when you save.
              <Button
                className="ml-3"
                onClick={reload}
                size="sm"
                type="button"
                variant="outline"
              >
                Reload
              </Button>
            </InlineAlert>
          ) : null}
          <section
            aria-labelledby={`${editorId}-command-tab`}
            className={cn("grid min-w-0 gap-4", tab !== "command" && "hidden")}
            id={`${editorId}-command-panel`}
            role="tabpanel"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={fieldClassName}>
                <span className={labelClassName}>Name</span>
                <Input
                  aria-describedby={
                    fieldErrors("name").length
                      ? `${editorId}-name-error`
                      : undefined
                  }
                  aria-invalid={fieldErrors("name").length > 0}
                  aria-label="Name"
                  autoFocus
                  value={document.name}
                  onBlur={() => touchField("name")}
                  onChange={(event) =>
                    patchDocument({ name: event.target.value })
                  }
                />
                <FieldErrors
                  id={`${editorId}-name-error`}
                  messages={fieldErrors("name")}
                />
              </label>
              <label className={fieldClassName}>
                <span className={labelClassName}>Provider</span>
                <NativeSelect disabled value={document.provider}>
                  <option value="shell">Shell</option>
                  <option value="node">Node / package</option>
                  <option value="java">Java</option>
                  <option value="dart">Dart</option>
                  <option value="flutter">Flutter</option>
                  <option value="rust">Rust / Cargo</option>
                </NativeSelect>
              </label>
              <div className={fieldClassName}>
                <span className={labelClassName}>Start directory</span>
                <div className="flex gap-2">
                  <Input
                    aria-label="Start directory"
                    aria-describedby={
                      fieldErrors("workingDirectory").length
                        ? `${editorId}-directory-error`
                        : undefined
                    }
                    aria-invalid={fieldErrors("workingDirectory").length > 0}
                    className="min-w-0 flex-1 font-mono"
                    placeholder="."
                    value={document.workingDirectory}
                    onBlur={() => touchField("workingDirectory")}
                    onChange={(event) =>
                      patchDocument({ workingDirectory: event.target.value })
                    }
                  />
                  <RunConfigurationPathPicker
                    ariaLabel="Browse start directories"
                    currentPath={document.workingDirectory}
                    onChoose={(workingDirectory) =>
                      patchDocument({ workingDirectory })
                    }
                    projectId={projectId}
                    purpose="directory"
                  />
                </div>
                <FieldErrors
                  id={`${editorId}-directory-error`}
                  messages={fieldErrors("workingDirectory")}
                />
              </div>
              <label className={fieldClassName}>
                <span className={labelClassName}>Target type</span>
                <NativeSelect
                  value={document.target.kind}
                  onChange={(event) => {
                    const kind = event.target.value;
                    patchDocument({
                      target:
                        document.provider === "shell"
                          ? kind === "script"
                            ? { kind: "script", path: "", interpreter: null }
                            : { kind: "command", command: "" }
                          : document.provider === "node"
                            ? kind === "entry"
                              ? { kind: "entry", path: "" }
                              : { kind: "packageScript", script: "start" }
                            : document.provider === "rust"
                              ? {
                                  kind:
                                    kind === "example" ? "example" : "binary",
                                  package: document.target.package,
                                  name: document.target.name,
                                }
                              : document.provider === "dart" ||
                                  document.provider === "flutter"
                                ? {
                                    kind: "entrypoint",
                                    path:
                                      document.provider === "dart"
                                        ? "bin/main.dart"
                                        : "lib/main.dart",
                                  }
                                : kind === "gradleMainClass"
                                  ? {
                                      kind: "gradleMainClass",
                                      projectPath: ":",
                                      className: "",
                                    }
                                  : kind === "mavenGoal"
                                    ? {
                                        kind: "mavenGoal",
                                        module: null,
                                        goal: "spring-boot:run",
                                      }
                                    : kind === "mavenMainClass"
                                      ? {
                                          kind: "mavenMainClass",
                                          module: null,
                                          className: "",
                                        }
                                      : {
                                          kind: "gradleTask",
                                          projectPath: ":",
                                          task: "run",
                                        },
                    });
                  }}
                >
                  {document.provider === "shell" ? (
                    <>
                      <option value="command">Command</option>
                      <option value="script">Script file</option>
                    </>
                  ) : document.provider === "node" ? (
                    <>
                      <option value="packageScript">Package script</option>
                      <option value="entry">Node entrypoint</option>
                    </>
                  ) : document.provider === "dart" ? (
                    <option value="entrypoint">Dart entrypoint</option>
                  ) : document.provider === "flutter" ? (
                    <option value="entrypoint">Flutter entrypoint</option>
                  ) : document.provider === "rust" ? (
                    <>
                      <option value="binary">Cargo binary</option>
                      <option value="example">Cargo example</option>
                    </>
                  ) : (
                    <>
                      <option value="gradleTask">Gradle task</option>
                      <option value="gradleMainClass">Gradle main class</option>
                      <option value="mavenGoal">Maven goal</option>
                      <option value="mavenMainClass">Maven main class</option>
                    </>
                  )}
                </NativeSelect>
              </label>
            </div>
            {document.provider !== "shell" ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className={labelClassName}>Target</div>
                  <code className="block truncate text-sm">
                    {runConfigurationTargetLabel(document)}
                  </code>
                </div>
                <RunConfigurationTargetPicker
                  candidates={targetDetection.data?.candidates ?? []}
                  current={document}
                  diagnostics={targetDetection.data?.diagnostics ?? []}
                  error={targetDetection.error ?? null}
                  fetching={targetDetection.isFetching}
                  open={targetPickerOpen}
                  onChoose={(candidate) => {
                    setDocument((current) =>
                      applyRunConfigurationDetectionCandidate(
                        current,
                        candidate,
                      ),
                    );
                    setTargetPickerOpen(false);
                  }}
                  onOpenChange={setTargetPickerOpen}
                  onRefresh={() => void targetDetection.refetch()}
                />
              </div>
            ) : null}
            {document.provider === "shell" ? (
              document.target.kind === "command" ? (
                <label className={fieldClassName}>
                  <span className={labelClassName}>Run command</span>
                  <Input
                    aria-describedby={
                      fieldErrors("target").length
                        ? `${editorId}-target-error`
                        : undefined
                    }
                    aria-invalid={fieldErrors("target").length > 0}
                    className="font-mono"
                    placeholder="pnpm dev"
                    value={document.target.command}
                    onBlur={() => touchField("target")}
                    onChange={(event) =>
                      patchDocument({
                        target: {
                          kind: "command",
                          command: event.target.value,
                        },
                      })
                    }
                  />
                </label>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className={fieldClassName}>
                    <span className={labelClassName}>Script path</span>
                    <div className="flex gap-2">
                      <Input
                        aria-label="Script path"
                        aria-describedby={
                          fieldErrors("target").length
                            ? `${editorId}-target-error`
                            : undefined
                        }
                        aria-invalid={fieldErrors("target").length > 0}
                        className="min-w-0 flex-1 font-mono"
                        placeholder="tool/run.sh"
                        value={document.target.path}
                        onBlur={() => touchField("target")}
                        onChange={(event) =>
                          setDocument((current) =>
                            current.provider === "shell" &&
                            current.target.kind === "script"
                              ? {
                                  ...current,
                                  target: {
                                    ...current.target,
                                    path: event.target.value,
                                  },
                                }
                              : current,
                          )
                        }
                      />
                      <RunConfigurationPathPicker
                        ariaLabel="Browse shell scripts"
                        currentPath={document.target.path}
                        onChoose={(path) =>
                          setDocument((current) =>
                            current.provider === "shell" &&
                            current.target.kind === "script"
                              ? {
                                  ...current,
                                  target: { ...current.target, path },
                                }
                              : current,
                          )
                        }
                        projectId={projectId}
                        purpose="shell-script"
                      />
                    </div>
                  </div>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>
                      Interpreter (optional)
                    </span>
                    <Input
                      className="font-mono"
                      placeholder="bash"
                      value={document.target.interpreter ?? ""}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "shell" &&
                          current.target.kind === "script"
                            ? {
                                ...current,
                                target: {
                                  ...current.target,
                                  interpreter: event.target.value || null,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                </div>
              )
            ) : document.provider === "node" ? (
              document.target.kind === "packageScript" ? (
                <label className={fieldClassName}>
                  <span className={labelClassName}>Package script</span>
                  <Input
                    className="font-mono"
                    placeholder="start"
                    value={document.target.script}
                    onBlur={() => touchField("target")}
                    onChange={(event) =>
                      setDocument((current) =>
                        current.provider === "node" &&
                        current.target.kind === "packageScript"
                          ? {
                              ...current,
                              target: {
                                kind: "packageScript",
                                script: event.target.value,
                              },
                            }
                          : current,
                      )
                    }
                  />
                </label>
              ) : (
                <div className={fieldClassName}>
                  <span className={labelClassName}>Entrypoint path</span>
                  <div className="flex gap-2">
                    <Input
                      aria-label="Node entrypoint path"
                      className="min-w-0 flex-1 font-mono"
                      placeholder="src/index.js"
                      value={document.target.path}
                      onBlur={() => touchField("target")}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "node" &&
                          current.target.kind === "entry"
                            ? {
                                ...current,
                                target: {
                                  kind: "entry",
                                  path: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                    />
                    <RunConfigurationPathPicker
                      ariaLabel="Browse Node entrypoints"
                      currentPath={document.target.path}
                      onChoose={(path) =>
                        setDocument((current) =>
                          current.provider === "node" &&
                          current.target.kind === "entry"
                            ? {
                                ...current,
                                target: { kind: "entry", path },
                              }
                            : current,
                        )
                      }
                      projectId={projectId}
                      purpose="file"
                    />
                  </div>
                </div>
              )
            ) : document.provider === "java" ? (
              <JavaTargetEditor
                document={document}
                projectId={projectId}
                onChange={setDocument}
              />
            ) : document.provider === "dart" ? (
              <DartTargetEditor
                document={document}
                projectId={projectId}
                onChange={setDocument}
              />
            ) : document.provider === "flutter" ? (
              <FlutterTargetEditor
                document={document}
                projectId={projectId}
                onChange={setDocument}
              />
            ) : (
              <RustTargetEditor document={document} onChange={setDocument} />
            )}
            <FieldErrors
              id={`${editorId}-target-error`}
              messages={fieldErrors("target")}
            />
            <div
              className="grid gap-2 border-t pt-3"
              onBlur={() => touchField("arguments")}
            >
              <h3 className={labelClassName}>Arguments</h3>
              <StringListEditor
                addLabel="Add argument"
                values={document.arguments}
                onChange={(arguments_) =>
                  patchDocument({ arguments: arguments_ })
                }
              />
              <FieldErrors messages={fieldErrors("arguments")} />
            </div>
            <details
              open={
                Boolean(document.commandOverride) ||
                fieldErrors("commandOverride").length > 0
              }
            >
              <summary className="w-fit cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                Command override{effective.overridden ? " (active)" : ""}
              </summary>
              <Input
                aria-label="Command override"
                className="mt-2 font-mono"
                placeholder="Replace the provider command"
                value={document.commandOverride ?? ""}
                onBlur={() => touchField("commandOverride")}
                onChange={(event) =>
                  patchDocument({ commandOverride: event.target.value || null })
                }
              />
              <FieldErrors messages={fieldErrors("commandOverride")} />
            </details>
            {effectiveCommand &&
            (document.provider !== "shell" ||
              document.target.kind !== "command" ||
              effective.overridden ||
              document.arguments.length > 0) ? (
              <div className="grid gap-1">
                <span className={labelClassName}>Effective command</span>
                <code className="break-all text-sm">{effectiveCommand}</code>
              </div>
            ) : null}
            <RunConfigurationValidationStatus
              error={validationIsCurrent ? providerValidation.error : null}
              onRediscover={
                document.provider === "shell"
                  ? null
                  : () => setTargetPickerOpen(true)
              }
              onRetry={() => void providerValidation.refetch()}
              pending={
                parsedDraft.success &&
                (!validationIsCurrent || providerValidation.isFetching)
              }
              validation={currentValidation}
            />
          </section>

          <section
            aria-labelledby={`${editorId}-environment-tab`}
            className={cn(
              "grid min-w-0 gap-4",
              tab !== "environment" && "hidden",
            )}
            id={`${editorId}-environment-panel`}
            role="tabpanel"
          >
            <label className="flex items-center gap-2 text-sm">
              <input
                checked={document.environment.includeCodexEnvironment}
                onChange={(event) =>
                  patchDocument({
                    environment: {
                      ...document.environment,
                      includeCodexEnvironment: event.target.checked,
                    },
                  })
                }
                type="checkbox"
              />
              Include Codex environment
            </label>
            <div
              className="grid gap-2 border-t pt-3"
              onBlur={() => touchField("environment.files")}
            >
              <span className={labelClassName}>Environment files</span>
              <StringListEditor
                addLabel="Add environment file"
                pathPicker={{
                  ariaLabel: "Browse environment file",
                  projectId,
                  purpose: "environment-file",
                }}
                values={document.environment.files}
                onChange={(files) =>
                  patchDocument({
                    environment: { ...document.environment, files },
                  })
                }
              />
              <FieldErrors messages={fieldErrors("environment.files")} />
            </div>
            <div
              className="grid gap-2 border-t pt-3"
              onBlur={() => touchField("environment.variables")}
            >
              <span className={labelClassName}>Variables</span>
              <EnvironmentRows
                kind="variable"
                rows={document.environment.variables}
                onChange={(rows) =>
                  patchDocument({
                    environment: { ...document.environment, variables: rows },
                  })
                }
              />
              <FieldErrors messages={fieldErrors("environment.variables")} />
            </div>
            <div
              className="grid gap-2 border-t pt-3"
              onBlur={() => touchField("environment.secrets")}
            >
              <span className={labelClassName}>Secret references</span>
              <EnvironmentRows
                kind="secret"
                rows={document.environment.secrets.map(
                  ({ name, secret, enabled }) => ({
                    name,
                    value: secret,
                    enabled,
                  }),
                )}
                secretReferences={suggestedSecretReferences}
                onChange={(rows) =>
                  patchDocument({
                    environment: {
                      ...document.environment,
                      secrets: rows.map(({ name, value, enabled }) => ({
                        name,
                        secret: value,
                        enabled,
                      })),
                    },
                  })
                }
              />
              <FieldErrors messages={fieldErrors("environment.secrets")} />
              {storedSecrets.error ? (
                <p className="text-xs text-destructive" role="alert">
                  Stored secret availability could not be loaded.
                </p>
              ) : null}
              {referencedSecrets.length > 0 ? (
                <div className="grid gap-2 pt-1">
                  <span className={labelClassName}>Write-only values</span>
                  {referencedSecrets.map((reference) => (
                    <SecretValueEditor
                      key={reference}
                      onSaved={updateSecretSummary}
                      projectId={projectId}
                      reference={reference}
                      summary={secretSummaries.get(reference) ?? null}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </section>

          <section
            aria-labelledby={`${editorId}-lifecycle-tab`}
            className={cn(
              "grid min-w-0 gap-3",
              tab !== "lifecycle" && "hidden",
            )}
            id={`${editorId}-lifecycle-panel`}
            role="tabpanel"
          >
            <h3 className="font-medium">Before launch</h3>
            {document.beforeLaunch.map((step, index) => (
              <div
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_auto]"
                key={index}
                onBlur={() => touchField("beforeLaunch")}
              >
                <NativeSelect
                  aria-label={`Before-launch step type ${index + 1}`}
                  className="col-span-full sm:col-span-1"
                  value={step.kind}
                  onChange={(event) =>
                    patchDocument({
                      beforeLaunch: document.beforeLaunch.map(
                        (item, itemIndex) =>
                          itemIndex === index
                            ? event.target.value === "providerTask" &&
                              supportsProviderTask
                              ? {
                                  kind: "providerTask",
                                  task:
                                    document.provider === "flutter"
                                      ? "pub get"
                                      : "build",
                                }
                              : {
                                  kind: "command",
                                  command: "",
                                  workingDirectory: ".",
                                }
                            : item,
                      ),
                    })
                  }
                >
                  <option value="command">Command</option>
                  {supportsProviderTask || step.kind === "providerTask" ? (
                    <option
                      disabled={!supportsProviderTask}
                      value="providerTask"
                    >
                      Provider task
                      {!supportsProviderTask ? " (unsupported)" : ""}
                    </option>
                  ) : null}
                </NativeSelect>
                <Input
                  aria-label={`Before-launch ${step.kind === "command" ? "command" : "task"} ${index + 1}`}
                  className="col-span-full sm:col-span-1"
                  value={step.kind === "command" ? step.command : step.task}
                  placeholder={
                    step.kind === "command" ? "Command" : "Task name"
                  }
                  onChange={(event) =>
                    patchDocument({
                      beforeLaunch: document.beforeLaunch.map(
                        (item, itemIndex) =>
                          itemIndex === index
                            ? item.kind === "command"
                              ? { ...item, command: event.target.value }
                              : { ...item, task: event.target.value }
                            : item,
                      ),
                    })
                  }
                />
                {step.kind === "command" ? (
                  <div className="flex min-w-0 gap-2">
                    <Input
                      aria-label={`Before-launch working directory ${index + 1}`}
                      className="min-w-0 flex-1 font-mono"
                      value={step.workingDirectory}
                      placeholder="Working directory"
                      onChange={(event) =>
                        patchDocument({
                          beforeLaunch: document.beforeLaunch.map(
                            (item, itemIndex) =>
                              itemIndex === index && item.kind === "command"
                                ? {
                                    ...item,
                                    workingDirectory: event.target.value,
                                  }
                                : item,
                          ),
                        })
                      }
                    />
                    <RunConfigurationPathPicker
                      ariaLabel={`Browse before-launch working directory ${index + 1}`}
                      currentPath={step.workingDirectory}
                      onChoose={(workingDirectory) =>
                        patchDocument({
                          beforeLaunch: document.beforeLaunch.map(
                            (item, itemIndex) =>
                              itemIndex === index && item.kind === "command"
                                ? { ...item, workingDirectory }
                                : item,
                          ),
                        })
                      }
                      projectId={projectId}
                      purpose="directory"
                    />
                  </div>
                ) : (
                  <span
                    className={cn(
                      "flex items-center text-xs",
                      supportsProviderTask
                        ? "text-muted-foreground"
                        : "text-destructive",
                    )}
                  >
                    {document.provider === "node"
                      ? "Runs a package script in the start directory."
                      : document.provider === "java"
                        ? "Runs a Gradle task or Maven goal in the selected module."
                        : document.provider === "flutter"
                          ? "Use clean, gen-l10n, or pub get in the Flutter package."
                          : document.provider === "rust"
                            ? "Use build, check, or clippy for the selected Cargo target."
                            : "Change this step to Command or remove it."}
                  </span>
                )}
                <Button
                  aria-label={`Remove before-launch step ${index + 1}`}
                  onClick={() =>
                    patchDocument({
                      beforeLaunch: document.beforeLaunch.filter(
                        (_, itemIndex) => itemIndex !== index,
                      ),
                    })
                  }
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <FieldErrors messages={fieldErrors("beforeLaunch")} />
            <Button
              className="w-fit"
              onClick={() =>
                patchDocument({
                  beforeLaunch: [
                    ...document.beforeLaunch,
                    { kind: "command", command: "", workingDirectory: "." },
                  ],
                })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              <Plus className="size-3.5" /> Add step
            </Button>
            <h3 className="mt-1 border-t pt-3 font-medium">
              Execution options
            </h3>
            <div
              className="grid gap-3 sm:grid-cols-3"
              onBlur={() => {
                touchField("options");
                touchField("stop");
              }}
            >
              {document.provider === "shell" ? (
                <>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Shell</span>
                    <NativeSelect
                      value={document.options.shell}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "shell"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  shell: event.target
                                    .value as RunConfigurationShellDocument["options"]["shell"],
                                },
                              }
                            : current,
                        )
                      }
                    >
                      {[
                        "automatic",
                        "powershell",
                        "cmd",
                        "sh",
                        "bash",
                        "zsh",
                      ].map((shell) => (
                        <option key={shell} value={shell}>
                          {shell}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input
                      checked={document.options.login}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "shell"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  login: event.target.checked,
                                },
                              }
                            : current,
                        )
                      }
                      type="checkbox"
                    />{" "}
                    Login shell
                  </label>
                </>
              ) : document.provider === "node" ? (
                <>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Package manager</span>
                    <NativeSelect
                      value={document.options.packageManager}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "node"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  packageManager: event.target
                                    .value as RunConfigurationNodeDocument["options"]["packageManager"],
                                },
                              }
                            : current,
                        )
                      }
                    >
                      {[
                        ["npm", "npm"],
                        ["pnpm", "pnpm"],
                        ["yarn", "Yarn"],
                        ["bun", "Bun"],
                      ].map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Runtime</span>
                    <NativeSelect
                      value={document.options.runtime}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "node"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  runtime: event.target
                                    .value as RunConfigurationNodeDocument["options"]["runtime"],
                                },
                              }
                            : current,
                        )
                      }
                    >
                      <option value="node">Node.js</option>
                      <option value="bun">Bun</option>
                    </NativeSelect>
                  </label>
                </>
              ) : document.provider === "java" ? (
                <>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>JDK home (optional)</span>
                    <Input
                      className="font-mono"
                      placeholder="Use worker JAVA_HOME"
                      value={document.options.jdkHome ?? ""}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "java"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  jdkHome: event.target.value || null,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input
                      checked={document.options.useWrapper}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "java"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  useWrapper: event.target.checked,
                                },
                              }
                            : current,
                        )
                      }
                      type="checkbox"
                    />{" "}
                    Use project wrapper
                  </label>
                </>
              ) : document.provider === "dart" ? (
                <label className={fieldClassName}>
                  <span className={labelClassName}>
                    Dart SDK home (optional)
                  </span>
                  <Input
                    className="font-mono"
                    placeholder="Use dart from the worker PATH"
                    value={document.options.sdkHome ?? ""}
                    onChange={(event) =>
                      setDocument((current) =>
                        current.provider === "dart"
                          ? {
                              ...current,
                              options: {
                                ...current.options,
                                sdkHome: event.target.value || null,
                              },
                            }
                          : current,
                      )
                    }
                  />
                </label>
              ) : document.provider === "flutter" ? (
                <>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>
                      Flutter SDK home (optional)
                    </span>
                    <Input
                      className="font-mono"
                      placeholder="Use flutter from the worker PATH"
                      value={document.options.sdkHome ?? ""}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "flutter"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  sdkHome: event.target.value || null,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <div className={fieldClassName}>
                    <span className={labelClassName}>
                      Target device (optional)
                    </span>
                    <div className="flex gap-2">
                      <Input
                        aria-label="Flutter target device ID"
                        className="min-w-0 flex-1 font-mono"
                        placeholder="Device ID or name, such as chrome"
                        value={document.options.deviceId ?? ""}
                        onChange={(event) =>
                          setDocument((current) =>
                            current.provider === "flutter"
                              ? {
                                  ...current,
                                  options: {
                                    ...current.options,
                                    deviceId: event.target.value || null,
                                  },
                                }
                              : current,
                          )
                        }
                      />
                      <RunConfigurationFlutterDevicePicker
                        currentDeviceId={document.options.deviceId ?? ""}
                        document={document}
                        projectId={projectId}
                        onChoose={(deviceId) =>
                          setDocument((current) =>
                            current.provider === "flutter"
                              ? {
                                  ...current,
                                  options: {
                                    ...current.options,
                                    deviceId,
                                  },
                                }
                              : current,
                          )
                        }
                      />
                    </div>
                    <span className="text-xs text-muted-foreground">
                      Enter a shared device ID manually or inspect devices on
                      Primary&apos;s worker.
                    </span>
                  </div>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Flavor (optional)</span>
                    <Input
                      className="font-mono"
                      placeholder="staging"
                      value={document.options.flavor ?? ""}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "flutter"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  flavor: event.target.value || null,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Build mode</span>
                    <NativeSelect
                      value={document.options.mode}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "flutter"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  mode: event.target
                                    .value as RunConfigurationFlutterDocument["options"]["mode"],
                                },
                              }
                            : current,
                        )
                      }
                    >
                      <option value="debug">Debug</option>
                      <option value="profile">Profile</option>
                      <option value="release">Release</option>
                    </NativeSelect>
                  </label>
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input
                      checked={document.options.usePub}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "flutter"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  usePub: event.target.checked,
                                },
                              }
                            : current,
                        )
                      }
                      type="checkbox"
                    />{" "}
                    Resolve packages before launch
                  </label>
                </>
              ) : (
                <>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Rust toolchain</span>
                    <Input
                      className="font-mono"
                      placeholder="default, stable, or nightly"
                      value={document.options.toolchain}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "rust"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  toolchain: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>Cargo profile</span>
                    <Input
                      className="font-mono"
                      placeholder="dev, release, or custom"
                      value={document.options.profile}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "rust"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  profile: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label className={fieldClassName}>
                    <span className={labelClassName}>
                      Target triple (optional)
                    </span>
                    <Input
                      className="font-mono"
                      placeholder="aarch64-apple-darwin"
                      value={document.options.targetTriple ?? ""}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "rust"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  targetTriple: event.target.value || null,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input
                      checked={document.options.useDefaultFeatures}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "rust"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  useDefaultFeatures: event.target.checked,
                                },
                              }
                            : current,
                        )
                      }
                      type="checkbox"
                    />{" "}
                    Enable default features
                  </label>
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input
                      checked={document.options.allFeatures}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "rust"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  allFeatures: event.target.checked,
                                },
                              }
                            : current,
                        )
                      }
                      type="checkbox"
                    />{" "}
                    Enable all features
                  </label>
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input
                      checked={document.options.locked}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "rust"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  locked: event.target.checked,
                                },
                              }
                            : current,
                        )
                      }
                      type="checkbox"
                    />{" "}
                    Require Cargo.lock
                  </label>
                  <label className="flex items-end gap-2 pb-2 text-sm">
                    <input
                      checked={document.options.offline}
                      onChange={(event) =>
                        setDocument((current) =>
                          current.provider === "rust"
                            ? {
                                ...current,
                                options: {
                                  ...current.options,
                                  offline: event.target.checked,
                                },
                              }
                            : current,
                        )
                      }
                      type="checkbox"
                    />{" "}
                    Offline mode
                  </label>
                </>
              )}
              <label className={fieldClassName}>
                <span className={labelClassName}>
                  Stop grace (milliseconds)
                </span>
                <Input
                  min={0}
                  max={60000}
                  type="number"
                  value={document.stop.gracePeriodMs}
                  onChange={(event) =>
                    patchDocument({
                      stop: { gracePeriodMs: Number(event.target.value) },
                    })
                  }
                />
              </label>
            </div>
            <FieldErrors
              messages={[...fieldErrors("options"), ...fieldErrors("stop")]}
            />
            {document.provider === "node" ? (
              <div className="grid gap-2">
                <span className={labelClassName}>Runtime arguments</span>
                <StringListEditor
                  addLabel="Add runtime argument"
                  values={document.options.runtimeArguments}
                  onChange={(runtimeArguments) =>
                    setDocument((current) =>
                      current.provider === "node"
                        ? {
                            ...current,
                            options: { ...current.options, runtimeArguments },
                          }
                        : current,
                    )
                  }
                />
              </div>
            ) : null}
            {document.provider === "java" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <span className={labelClassName}>Build-tool arguments</span>
                  <StringListEditor
                    addLabel="Add build-tool argument"
                    values={document.options.buildToolArguments}
                    onChange={(buildToolArguments) =>
                      setDocument((current) =>
                        current.provider === "java"
                          ? {
                              ...current,
                              options: {
                                ...current.options,
                                buildToolArguments,
                              },
                            }
                          : current,
                      )
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <span className={labelClassName}>Java VM arguments</span>
                  <StringListEditor
                    addLabel="Add VM argument"
                    values={document.options.vmArguments}
                    onChange={(vmArguments) =>
                      setDocument((current) =>
                        current.provider === "java"
                          ? {
                              ...current,
                              options: { ...current.options, vmArguments },
                            }
                          : current,
                      )
                    }
                  />
                </div>
              </div>
            ) : null}
            {document.provider === "dart" ? (
              <div className="grid gap-2">
                <span className={labelClassName}>Dart VM arguments</span>
                <StringListEditor
                  addLabel="Add VM argument"
                  values={document.options.vmArguments}
                  onChange={(vmArguments) =>
                    setDocument((current) =>
                      current.provider === "dart"
                        ? {
                            ...current,
                            options: { ...current.options, vmArguments },
                          }
                        : current,
                    )
                  }
                />
              </div>
            ) : null}
            {document.provider === "flutter" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <span className={labelClassName}>Dart defines</span>
                  <DartDefineRows
                    rows={document.options.dartDefines}
                    onChange={(dartDefines) =>
                      setDocument((current) =>
                        current.provider === "flutter"
                          ? {
                              ...current,
                              options: { ...current.options, dartDefines },
                            }
                          : current,
                      )
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <span className={labelClassName}>Dart define files</span>
                  <StringListEditor
                    addLabel="Add define file"
                    pathPicker={{
                      ariaLabel: "Browse Dart define file",
                      projectId,
                      purpose: "file",
                    }}
                    values={document.options.dartDefineFiles}
                    onChange={(dartDefineFiles) =>
                      setDocument((current) =>
                        current.provider === "flutter"
                          ? {
                              ...current,
                              options: {
                                ...current.options,
                                dartDefineFiles,
                              },
                            }
                          : current,
                      )
                    }
                  />
                </div>
              </div>
            ) : null}
            {document.provider === "rust" ? (
              <div className="grid gap-2">
                <span className={labelClassName}>Cargo features</span>
                <StringListEditor
                  addLabel="Add Cargo feature"
                  values={document.options.features}
                  onChange={(features) =>
                    setDocument((current) =>
                      current.provider === "rust"
                        ? {
                            ...current,
                            options: { ...current.options, features },
                          }
                        : current,
                    )
                  }
                />
              </div>
            ) : null}
            <details
              className="border-t pt-3"
              open={fieldErrors("platformOverrides").length > 0}
            >
              <summary className="w-fit cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                Platform overrides
              </summary>
              <label className={cn(fieldClassName, "mt-2")}>
                <span className={labelClassName}>Override JSON</span>
                <textarea
                  className={textareaClassName}
                  value={platformOverrides}
                  onBlur={() => touchField("platformOverrides")}
                  onChange={(event) => setPlatformOverrides(event.target.value)}
                />
              </label>
              <FieldErrors messages={fieldErrors("platformOverrides")} />
            </details>
            <details className="border-t pt-3 text-sm text-muted-foreground">
              <summary className="w-fit cursor-pointer hover:text-foreground">
                Shared file
              </summary>
              <code className="mt-2 block break-all text-xs">
                .cantrip/run-configurations/{document.id}.json
              </code>
              {destinationLabel ? (
                <p className="mt-1 text-xs">{destinationLabel}</p>
              ) : null}
            </details>
          </section>
        </form>
        <div className="max-h-32 shrink-0 space-y-2 overflow-y-auto px-4 empty:hidden sm:px-6">
          {errors.length ? (
            <InlineAlert tone="error" title="Could not save">
              <ul className="list-disc pl-4">
                {errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </InlineAlert>
          ) : null}
          {save.error ? <InlineAlert error={save.error} tone="error" /> : null}
        </div>
        <DialogFooter className="shrink-0 flex-row flex-wrap items-center justify-end border-t px-4 py-3 sm:px-6">
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          {conflictRevision ? (
            <Button
              disabled={externallyDeleted}
              onClick={() => save.mutate(conflictRevision)}
              pending={save.isPending}
              type="button"
              variant="destructive"
            >
              Overwrite latest revision
            </Button>
          ) : null}
          <Button
            disabled={externallyDeleted}
            form={`${editorId}-form`}
            pending={save.isPending}
            pendingLabel="Saving…"
            type="submit"
          >
            Save configuration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

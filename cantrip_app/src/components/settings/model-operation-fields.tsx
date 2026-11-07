import {
  modelOperationOptionsSchema,
  type ModelOperation,
  type ModelOperationAdapter,
  type ModelOperationOptions,
} from "@cantrip/protocol";
import { NativeSelect } from "@/components/ui/native-select";

const fieldClass =
  "h-8 min-w-0 rounded-md border bg-background px-2 text-xs outline-none ring-ring focus:ring-2";
const adapters: Record<
  Exclude<ModelOperation, "language">,
  [ModelOperationAdapter, string][]
> = {
  embedding: [
    ["openai-embeddings", "OpenAI-compatible embeddings"],
    ["ollama-embed", "Ollama embed"],
    ["llama-embeddings", "llama.cpp native embeddings"],
    ["vllm-embeddings", "vLLM embeddings / chat inputs"],
    ["vllm-pooling", "vLLM embedding pooling"],
    ["vllm-bge-m3", "vLLM BGE-M3 sparse plugin"],
    ["cohere-embed", "Cohere-compatible Embed v2"],
  ],
  decision: [
    ["openai-decisions", "OpenAI Decisions"],
    ["system-one", "System One"],
    ["openrouter-decisions", "OpenRouter Decisions"],
  ],
};

export function ModelOperationFields({
  operation,
  adapter,
  options,
  onChange,
}: {
  operation: Exclude<ModelOperation, "language">;
  adapter: ModelOperationAdapter | null | undefined;
  options: ModelOperationOptions | null | undefined;
  onChange(input: {
    operationAdapter?: ModelOperationAdapter | null;
    operationOptions?: ModelOperationOptions;
  }): void;
}) {
  const mediaFormats: [string, string][] =
    operation === "decision"
      ? adapter === "system-one"
        ? [["base64-images", "Shared base64 media"]]
        : [["content-parts", "Content parts"]]
      : adapter === "ollama-embed" || adapter === "vllm-bge-m3"
        ? []
        : adapter === "vllm-embeddings" || adapter === "vllm-pooling"
          ? [
              ["content-parts", "Chat content parts"],
              ["media-urls", "Chat media URLs"],
            ]
          : adapter === "cohere-embed" || adapter === "llama-embeddings"
            ? [["content-parts", "Content parts"]]
            : [
                ["content-parts", "Content parts"],
                ["base64-images", "Base64 images (gateway)"],
              ];
  const patch = (key: keyof ModelOperationOptions, value: unknown) => {
    const next = { ...options, [key]: value };
    if (value === undefined) delete next[key];
    onChange({ operationOptions: next as ModelOperationOptions });
  };
  const textField = (
    label: string,
    key:
      | "inputType"
      | "normalization"
      | "modelRevision"
      | "embeddingSpace"
      | "messageRole",
  ) => (
    <label className="grid min-w-0 gap-1 text-xs">
      <span>{label}</span>
      <input
        className={fieldClass}
        maxLength={
          key === "embeddingSpace"
            ? 1000
            : key === "normalization" || key === "messageRole"
              ? 80
              : key === "modelRevision"
                ? 500
                : 160
        }
        value={options?.[key] ?? ""}
        onChange={(event) => patch(key, event.target.value || undefined)}
      />
    </label>
  );
  const numberField = (
    label: string,
    key: "dimensions" | "maxBatchSize" | "timeoutMs",
  ) => (
    <label className="grid min-w-0 gap-1 text-xs">
      <span>{label}</span>
      <input
        className={fieldClass}
        type="number"
        min={1}
        step={1}
        value={options?.[key] ?? ""}
        placeholder="Provider default"
        onChange={(event) => {
          const value = event.target.value;
          if (
            !value ||
            (Number.isSafeInteger(Number(value)) && Number(value) > 0)
          )
            patch(key, value ? Number(value) : undefined);
        }}
      />
    </label>
  );
  return (
    <div className="col-span-full grid gap-3 pb-2 pl-1">
      <label className="grid gap-1 text-xs">
        <span>Operation API</span>
        <NativeSelect
          className={fieldClass}
          value={adapter ?? ""}
          onChange={(event) =>
            onChange({
              operationAdapter:
                (event.target.value as ModelOperationAdapter) || null,
            })
          }
        >
          <option value="">Automatic from connection and model</option>
          {adapters[operation].map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </label>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Operation options
        </summary>
        <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
          {operation === "embedding" ? (
            <>
              {numberField("Dimensions", "dimensions")}
              {textField("Input mode (query / document)", "inputType")}
              {textField("Normalization", "normalization")}
              {textField("Embedding space identifier", "embeddingSpace")}
              {numberField("Maximum items per batch", "maxBatchSize")}
              {textField("Embedding message role", "messageRole")}
              <label className="grid gap-1 text-xs">
                <span>Vector representation</span>
                <NativeSelect
                  className={fieldClass}
                  value={options?.vectorRepresentation ?? ""}
                  onChange={(event) =>
                    patch(
                      "vectorRepresentation",
                      event.target.value || undefined,
                    )
                  }
                >
                  <option value="">Provider response</option>
                  <option value="dense">Dense</option>
                  <option value="multi-vector">Multi-vector</option>
                  <option value="sparse">Sparse</option>
                  <option value="hybrid">Dense + sparse</option>
                </NativeSelect>
              </label>
              <label className="grid gap-1 text-xs">
                <span>vLLM pooling task</span>
                <NativeSelect
                  className={fieldClass}
                  value={options?.poolingTask ?? ""}
                  onChange={(event) =>
                    patch("poolingTask", event.target.value || undefined)
                  }
                >
                  <option value="">Adapter default</option>
                  <option value="embed">Sequence embedding</option>
                  <option value="token_embed">Token embedding</option>
                </NativeSelect>
              </label>
              <label className="grid gap-1 text-xs">
                <span>Vector encoding</span>
                <NativeSelect
                  className={fieldClass}
                  value={options?.encodingFormat ?? ""}
                  onChange={(event) =>
                    patch("encodingFormat", event.target.value || undefined)
                  }
                >
                  <option value="">Provider default</option>
                  <option value="float">Float</option>
                  <option value="base64">Base64</option>
                </NativeSelect>
              </label>
            </>
          ) : null}
          {textField("Model revision", "modelRevision")}
          {numberField("Request timeout (milliseconds)", "timeoutMs")}
          <label className="grid min-w-0 gap-1 text-xs">
            <span>Configured input modalities (comma separated)</span>
            <input
              className={fieldClass}
              defaultValue={options?.inputModalities?.join(", ") ?? ""}
              onChange={(event) =>
                patch(
                  "inputModalities",
                  event.target.value.trim()
                    ? event.target.value
                        .split(",")
                        .map((part) => part.trim())
                        .filter(Boolean)
                    : undefined,
                )
              }
            />
          </label>
          <label className="grid gap-1 text-xs">
            <span>Media encoding</span>
            <NativeSelect
              className={fieldClass}
              value={options?.mediaFormat ?? ""}
              onChange={(event) =>
                patch("mediaFormat", event.target.value || undefined)
              }
            >
              <option value="">Adapter default</option>
              {mediaFormats.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
              {options?.mediaFormat &&
              !mediaFormats.some(([value]) => value === options.mediaFormat) ? (
                <option value={options.mediaFormat}>
                  Saved format: {options.mediaFormat}
                </option>
              ) : null}
            </NativeSelect>
          </label>
          {(["providerRouting", "parameters"] as const).map((key) => (
            <label key={key} className="col-span-full grid gap-1 text-xs">
              <span>
                {key === "providerRouting"
                  ? "Gateway routing options (JSON)"
                  : "Additional provider parameters (JSON)"}
              </span>
              <textarea
                className="min-h-20 rounded-md border bg-background p-2 font-mono text-xs"
                defaultValue={
                  options?.[key] ? JSON.stringify(options[key], null, 2) : ""
                }
                onInvalid={(event) => {
                  const details = event.currentTarget.closest("details");
                  if (details) details.open = true;
                }}
                onChange={(event) => {
                  try {
                    const parsed = modelOperationOptionsSchema.parse({
                      [key]: event.target.value.trim()
                        ? JSON.parse(event.target.value)
                        : undefined,
                    });
                    patch(key, parsed[key]);
                    event.target.setCustomValidity("");
                  } catch {
                    event.target.setCustomValidity(
                      "Enter a valid bounded JSON object.",
                    );
                  }
                }}
              />
            </label>
          ))}
          <p className="col-span-full text-muted-foreground">
            Leave options blank to use provider defaults. Configure media and
            request options according to the selected endpoint.
          </p>
        </div>
      </details>
    </div>
  );
}

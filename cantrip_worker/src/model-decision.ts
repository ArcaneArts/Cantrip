import {
  observeModelOperationRequest,
  reportedModelOperationUsage,
  type ModelOperationUsageCollector,
} from "./model-operation-usage.js";
import {
  MODEL_OPERATION_CONTENT_BYTES_LIMIT,
  decisionInputSchema,
  decisionResultSchema,
  normalizeResponsesBaseUrl,
  operationProviderFamily,
  type DecisionInput,
  type DecisionResult,
  type DecisionQuestion,
  type DecisionAnswer,
  type ModelOperationRoute,
  type ModelOperationOptions,
} from "@cantrip/protocol";
import {
  claimInferenceCommandSource,
  inferenceCommandSignal,
  trackInferenceCommandOperation,
} from "./inference-command.js";
import type {
  InferencePreparationContext,
  WorkerInferenceAdmission,
} from "./inference-admission.js";
import type { RuntimeProvider } from "./protected-secrets.js";
import { ModelOperationError } from "./model-operation-error.js";
import {
  decisionClipFields,
  inlineDecisionMedia as data,
  systemOneMedia,
} from "./model-decision-media.js";

type Route = Omit<ModelOperationRoute, "provider"> & {
  provider: RuntimeProvider;
};
type Adapter = DecisionResult["adapter"];
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const fail = (
  code: "invalid-request" | "unsupported-input" | "invalid-response",
  message: string,
): never => {
  throw new ModelOperationError(code, message);
};
function malformed(): never {
  return fail(
    "invalid-response",
    "The provider returned malformed decision answers.",
  );
}
function probability(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    malformed();
  return value;
}
function optionalProbability(value: unknown): number | null {
  return value === undefined || value === null ? null : probability(value);
}
function count(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    malformed();
  return value;
}
function endpoint(route: Route, adapter: Adapter): string {
  let base = normalizeResponsesBaseUrl(route.provider.baseUrl);
  if (/\/(?:decisions|systemone)$/.test(base)) return base;
  if (adapter === "openrouter-decisions")
    return `${base.replace(/\/v1$/, "/alpha")}/decisions`;
  if (adapter === "system-one") {
    if (
      !base.endsWith("/v1") &&
      (operationProviderFamily(route.provider) === "ollama" ||
        new URL(base).pathname === "/")
    )
      base += "/v1";
    return `${base}/systemone`;
  }
  return `${base}/decisions`;
}
function makePayload(
  route: Route,
  request: DecisionInput,
  options: ModelOperationOptions,
) {
  const family = operationProviderFamily(route.provider);
  const adapter =
    route.adapter ??
    route.capabilities.decision?.adapter ??
    (family === "openrouter"
      ? "openrouter-decisions"
      : ["ollama", "llama-cpp", "vllm"].includes(family)
        ? "system-one"
        : "openai-decisions");
  if (
    !["openai-decisions", "system-one", "openrouter-decisions"].includes(
      adapter,
    ) ||
    ["chatgpt", "grok"].includes(route.provider.kind)
  )
    throw new ModelOperationError(
      "configuration-required",
      "This connection does not expose the configured native decision API.",
    );
  const selected = adapter as Adapter;
  if (
    options.dimensions ||
    options.inputType ||
    options.encodingFormat ||
    options.normalization ||
    options.embeddingSpace ||
    options.vectorRepresentation ||
    options.poolingTask ||
    options.messageRole
  )
    fail(
      "invalid-request",
      "Embedding options cannot be used for a native decision request.",
    );
  const reserved = new Set([
    "model",
    "input",
    "state",
    "questions",
    "images",
    "audio",
    "videos",
    "files",
    "assets",
    "messages",
    "provider",
    "stream",
    "api_key",
    "apikey",
    "api-key",
    "access_token",
    "base_url",
    "api_base",
    "baseurl",
    "headers",
    "extra_headers",
    "authorization",
  ]);
  if (
    Object.keys(options.parameters ?? {}).some((key) =>
      reserved.has(key.toLowerCase()),
    )
  )
    fail(
      "invalid-request",
      "Additional parameters cannot replace decision inputs, routing, credentials or typed questions.",
    );
  const media = request.media ?? [];
  let body: Record<string, unknown>;
  if (selected === "openai-decisions") {
    const gatewayMedia =
      family === "litellm" || options.mediaFormat === "media-urls";
    if (!gatewayMedia && media.some((part) => part.type !== "image"))
      fail(
        "unsupported-input",
        "The OpenAI Decisions envelope accepts images, text and JSON, not audio or video.",
      );
    if (
      options.providerRouting ||
      (options.mediaFormat &&
        !["content-parts", "media-urls"].includes(options.mediaFormat))
    )
      fail(
        "invalid-request",
        "The OpenAI Decisions adapter does not accept these routing or media-format options.",
      );
    const questions = request.questions.map((question) => ({
      type: question.type,
      name: question.id,
      instructions:
        question.type === "predicate" && question.criteria
          ? `${question.instructions}\nTrue: ${question.criteria.true}\nFalse: ${question.criteria.false}`
          : question.instructions,
      ...(question.type === "choice"
        ? {
            choices: question.choices.map((choice) => ({
              value: choice.id,
              description: choice.description,
            })),
          }
        : {}),
      ...(question.type === "score"
        ? {
            levels: question.levels.map((level) => ({
              label: level.id,
              description: level.description,
            })),
          }
        : {}),
    }));
    body = {
      ...options.parameters,
      model: route.modelName,
      input: [
        {
          role: "user",
          content: [
            typeof request.state === "string"
              ? { type: "input_text", text: request.state }
              : { type: "input_json", data: request.state },
            ...media
              .filter((part) => part.type === "image")
              .map((part) => ({
                type: "input_image",
                image_url: part.url,
              })),
          ],
        },
      ],
      questions,
      ...(gatewayMedia ? decisionClipFields(media) : {}),
    };
  } else {
    const questions = Object.fromEntries(
      request.questions.map((question) => [
        question.id,
        {
          type: question.type === "predicate" ? "noul" : question.type,
          instructions: question.instructions,
          ...(question.type === "predicate" && question.criteria
            ? { criteria: question.criteria }
            : {}),
          ...(question.type === "choice"
            ? {
                criteria: Object.fromEntries(
                  question.choices.map((choice) => [
                    choice.id,
                    choice.description,
                  ]),
                ),
              }
            : {}),
          ...(question.type === "score"
            ? { criteria: question.levels.map((level) => level.description) }
            : {}),
        },
      ]),
    );
    if (selected === "system-one") {
      if (options.providerRouting)
        fail(
          "invalid-request",
          "System One does not accept OpenRouter routing options.",
        );
      const nativeMedia = systemOneMedia(family, options, media);
      body = {
        ...options.parameters,
        model: route.modelName,
        state: nativeMedia.references.length
          ? [request.state, ...nativeMedia.references]
          : request.state,
        questions,
        ...nativeMedia.fields,
      };
    } else {
      if (options.typesafeImages)
        fail(
          "invalid-request",
          "OpenRouter Decisions uses its own image parts and does not need the TypeSafe gateway header.",
        );
      if (options.mediaFormat && options.mediaFormat !== "content-parts")
        fail(
          "invalid-request",
          "OpenRouter Decisions uses native top-level state content parts.",
        );
      const parts = media.map((part) => {
        const encoded = data(part.url, part.type);
        if (part.type === "image")
          return { type: "image_url", image_url: { url: part.url } };
        if (part.type === "video")
          return { type: "video_url", video_url: { url: part.url } };
        const format = encoded.mime.slice("audio/".length).replace(/^x-/, "");
        if (
          ![
            "wav",
            "mp3",
            "mpeg",
            "m4a",
            "mp4",
            "aac",
            "aiff",
            "aif",
            "flac",
            "ogg",
            "opus",
            "webm",
          ].includes(format)
        )
          return fail(
            "unsupported-input",
            "This audio encoding is not supported by the OpenRouter decision envelope.",
          );
        return {
          type: "input_audio",
          input_audio: { data: encoded.base64, format },
        };
      });
      body = {
        ...options.parameters,
        model: route.modelName,
        state: parts.length ? [request.state, ...parts] : request.state,
        questions,
        ...(options.providerRouting
          ? { provider: options.providerRouting }
          : {}),
      };
    }
  }
  return { adapter: selected, url: endpoint(route, selected), body };
}
function distribution(
  raw: unknown,
  question: Extract<DecisionQuestion, { type: "choice" | "score" }>,
  adapter: Adapter,
) {
  if (raw === undefined || raw === null) return null;
  const options =
    question.type === "choice" ? question.choices : question.levels;
  const pairs =
    adapter === "openai-decisions"
      ? Array.isArray(raw)
        ? raw.map((value) => {
            const entry = object(value);
            if (
              question.type === "score" &&
              entry.label !== undefined &&
              entry.label !== question.levels[Number(entry.value)]?.id
            )
              malformed();
            return [entry.value, entry.probability] as const;
          })
        : malformed()
      : Object.entries(object(raw));
  if (pairs.length !== options.length) malformed();
  const probabilities = new Map<string, number>();
  for (const [key, value] of pairs) {
    const index =
      question.type === "choice"
        ? options.findIndex((option) => option.id === key)
        : options.findIndex((_, i) => key === i || key === String(i));
    if (index < 0 || probabilities.has(options[index]!.id)) malformed();
    probabilities.set(options[index]!.id, probability(value));
  }
  const sum = [...probabilities.values()].reduce(
    (total, value) => total + value,
    0,
  );
  if (Math.abs(sum - 1) > 0.01) malformed();
  return options.map((option) => ({
    id: option.id,
    probability: probabilities.get(option.id)!,
  }));
}
function answer(
  raw: unknown,
  question: DecisionQuestion,
  adapter: Adapter,
): DecisionAnswer {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) malformed();
  const value = object(raw);
  const common = {
    id: question.id,
    nativeAnswer: raw as DecisionAnswer["nativeAnswer"],
  };
  if (value.type === "refusal") {
    const reason = value.refusal ?? value.reason;
    if (reason !== undefined && reason !== null && typeof reason !== "string")
      malformed();
    return {
      ...common,
      type: "refusal",
      reason: typeof reason === "string" ? reason : null,
    };
  }
  if (
    value.type === "error" ||
    (value.error !== undefined && value.error !== null)
  )
    return {
      ...common,
      type: "error",
      error: (value.error ?? value) as DecisionAnswer["nativeAnswer"],
    };
  if (
    value.type !==
    (question.type === "predicate" && adapter !== "openai-decisions"
      ? "noul"
      : question.type)
  )
    malformed();
  if (question.type === "predicate")
    return {
      ...common,
      type: "predicate",
      probability: probability(
        adapter === "openai-decisions" ? value.probability : value.noul,
      ),
    };
  const probabilities = distribution(value.probabilities, question, adapter);
  const confidence = optionalProbability(value.confidence);
  if (question.type === "choice") {
    if (
      typeof value.choice !== "string" ||
      !question.choices.some((option) => option.id === value.choice)
    )
      malformed();
    return {
      ...common,
      type: "choice",
      choice: value.choice,
      probabilities,
      confidence,
    };
  }
  if (
    typeof value.score !== "number" ||
    !Number.isFinite(value.score) ||
    value.score < 0 ||
    value.score > question.levels.length - 1
  )
    malformed();
  if (probabilities) {
    const expected = probabilities.reduce(
      (total, entry, index) => total + index * entry.probability,
      0,
    );
    if (
      Math.abs(value.score - expected) >
      0.01 * question.levels.length + 0.001
    )
      malformed();
  }
  return {
    ...common,
    type: "score",
    score: value.score,
    probabilities,
    confidence,
    levels: question.levels,
    semantics: "probability-weighted-zero-based-index",
  };
}
async function execute(
  route: Route,
  request: DecisionInput,
  options: ModelOperationOptions,
  signal: AbortSignal,
  fetcher: typeof fetch,
  usageCollector?: ModelOperationUsageCollector,
): Promise<DecisionResult> {
  const payload = makePayload(route, request, options);
  const body = JSON.stringify(payload.body);
  if (Buffer.byteLength(body) > MODEL_OPERATION_CONTENT_BYTES_LIMIT)
    fail("invalid-request", "The native decision request exceeds 4 MiB.");
  return observeModelOperationRequest(
    usageCollector,
    signal,
    async (report) => {
      let response: Response;
      try {
        response = await fetcher(payload.url, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(options.typesafeImages
              ? { "TypeSafe-Danger-Zone-Images": "true" }
              : {}),
            ...(route.provider.apiKey
              ? { authorization: `Bearer ${route.provider.apiKey}` }
              : {}),
          },
          body,
        });
      } catch {
        if (signal.aborted) throw signal.reason;
        throw new ModelOperationError(
          "provider-error",
          "The decision provider request failed.",
        );
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      try {
        if (!response.ok)
          throw new ModelOperationError(
            "provider-error",
            `The decision provider returned HTTP ${response.status}.`,
            response.status,
          );
        if (!reader) malformed();
        let bytes = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MODEL_OPERATION_CONTENT_BYTES_LIMIT)
            fail("invalid-response", "The decision response exceeds 4 MiB.");
          chunks.push(part.value);
        }
        signal.throwIfAborted();
        let raw: Record<string, unknown>;
        const joined = Buffer.concat(chunks);
        try {
          raw = object(JSON.parse(joined.toString("utf8")));
        } catch {
          malformed();
        } finally {
          joined.fill(0);
        }
        report(reportedModelOperationUsage(raw, "decision"));
        let answers: DecisionAnswer[];
        if (payload.adapter === "openai-decisions") {
          if (
            !Array.isArray(raw.answers) ||
            raw.answers.length !== request.questions.length
          )
            malformed();
          const byId = new Map<string, unknown>();
          for (const item of raw.answers) {
            const name = object(item).name;
            if (
              typeof name !== "string" ||
              byId.has(name) ||
              !request.questions.some((question) => question.id === name)
            )
              malformed();
            byId.set(name, item);
          }
          answers = request.questions.map((question) =>
            answer(byId.get(question.id), question, payload.adapter),
          );
        } else {
          const entries = object(raw.answers);
          if (Object.keys(entries).length !== request.questions.length)
            malformed();
          answers = request.questions.map((question) =>
            answer(
              Object.hasOwn(entries, question.id)
                ? entries[question.id]
                : undefined,
              question,
              payload.adapter,
            ),
          );
        }
        const usage = object(raw.usage);
        const cost = usage.cost;
        if (
          cost !== undefined &&
          cost !== null &&
          (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
        )
          malformed();
        const result = decisionResultSchema.parse({
          modelId: route.modelId,
          routeId: route.routeId,
          providerId: route.provider.id,
          requestedModel: route.modelName,
          actualModel:
            typeof raw.model === "string" && raw.model ? raw.model : null,
          actualProvider:
            typeof raw.provider === "string" && raw.provider
              ? raw.provider
              : null,
          adapter: payload.adapter,
          status: answers.some((value) => value.type === "error")
            ? "partial"
            : "complete",
          answers,
          usage: {
            inputTokens: count(usage.input_tokens ?? usage.prompt_tokens),
            outputTokens: count(usage.output_tokens ?? usage.completion_tokens),
            totalTokens: count(usage.total_tokens),
            cost: cost ?? null,
          },
        });
        if (
          Buffer.byteLength(
            JSON.stringify({ status: "succeeded", value: result }),
          ) > MODEL_OPERATION_CONTENT_BYTES_LIMIT
        )
          fail(
            "invalid-response",
            "The normalized decision response exceeds 4 MiB.",
          );
        return result;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof ModelOperationError) throw error;
        malformed();
      } finally {
        for (const chunk of chunks) chunk.fill(0);
        if (reader) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
    },
  );
}

/** Native decisions, standalone or in an explicit blocked native preparation. */
export async function decide(input: {
  request: DecisionInput;
  route: Route;
  admission: WorkerInferenceAdmission;
  preparation?: InferencePreparationContext;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  usageCollector?: ModelOperationUsageCollector;
}): Promise<DecisionResult> {
  const request = decisionInputSchema.parse(input.request);
  const { route, admission } = input;
  const options = {
    ...route.options,
    ...request.options,
    parameters: { ...route.options.parameters, ...request.options?.parameters },
  };
  admission.configure({
    providerId: route.provider.id,
    maxConcurrentInference: route.provider.maxConcurrentInference,
    inferenceConfigRevision: route.provider.inferenceConfigRevision,
    inferenceCatalogCreatedRevision:
      route.provider.inferenceCatalogCreatedRevision,
  });
  const signal = AbortSignal.any(
    [input.signal, input.preparation?.signal, inferenceCommandSignal()].filter(
      (value): value is AbortSignal => Boolean(value),
    ),
  );
  const source = claimInferenceCommandSource(signal);
  if (!source)
    throw new ModelOperationError(
      "configuration-required",
      "Decision inference requires an authenticated canonical worker command.",
    );
  trackInferenceCommandOperation(source.source.operationId);
  try {
    return await admission.runDirect(
      {
        source: source.source,
        providerId: route.provider.id,
        providerCreationRevision:
          route.provider.inferenceCatalogCreatedRevision,
        signal,
        preparation: input.preparation,
      },
      (permission) =>
        execute(
          route,
          request,
          options,
          AbortSignal.any([
            permission,
            AbortSignal.timeout(options.timeoutMs ?? 120000),
          ]),
          input.fetcher ?? globalThis.fetch,
          input.usageCollector,
        ),
    );
  } catch (error) {
    if (signal.aborted)
      throw new ModelOperationError(
        "cancelled",
        "The decision operation was cancelled.",
      );
    if (error instanceof Error && error.name === "TimeoutError")
      throw new ModelOperationError(
        "provider-error",
        "The decision provider request timed out.",
      );
    throw error;
  } finally {
    source.close();
  }
}

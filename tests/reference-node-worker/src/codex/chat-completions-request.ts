import { z } from "zod";

export class AdapterProtocolError extends Error {}

export type JsonObject = Record<string, unknown>;
/** Classify a private backend error without returning any of its content. */
export function chatCompletionFailureMessage(detail: string): string {
  if (/context.{0,40}(length|limit|exceed)|maximum.{0,20}context/i.test(detail))
    return "The model rejected the request's context size.";
  if (
    /model.{0,30}(not found|unknown|unavailable|does not exist)|unknown model/i.test(
      detail,
    )
  )
    return "Model unavailable from the Chat Completions provider.";
  if (
    /unauthorized|forbidden|invalid.{0,10}api.{0,4}key|authentication/i.test(
      detail,
    )
  )
    return "The Chat Completions provider rejected authentication.";
  return "The Chat Completions provider returned an inference error.";
}
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AdapterProtocolError(
      "Expected a JSON object in the inference protocol.",
    );
  return value as JsonObject;
}
function string(value: unknown): string {
  if (typeof value !== "string")
    throw new AdapterProtocolError("Expected inference text.");
  return value;
}

function content(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value))
    throw new AdapterProtocolError("Unsupported message content.");
  const parts = value.map((part) => {
    const item = object(part);
    if (["input_text", "output_text", "text"].includes(String(item.type)))
      return { type: "text", text: string(item.text) };
    if (item.type === "input_image" && typeof item.image_url === "string")
      return {
        type: "image_url",
        image_url: {
          url: item.image_url,
          ...(item.detail ? { detail: item.detail } : {}),
        },
      };
    throw new AdapterProtocolError(
      "Unsupported message content type for Chat Completions.",
    );
  });
  return parts.every((part) => part.type === "text")
    ? parts.map((part) => part.text).join("")
    : parts;
}

export function responsesMessages(
  input: unknown,
  instructions?: unknown,
): JsonObject[] {
  const messages: JsonObject[] = [];
  if (instructions !== undefined && instructions !== null)
    messages.push({ role: "system", content: string(instructions) });
  const items =
    typeof input === "string" ? [{ role: "user", content: input }] : input;
  if (!Array.isArray(items))
    throw new AdapterProtocolError("Responses input must contain messages.");
  const assistant = () => {
    let last = messages.at(-1);
    if (last?.role !== "assistant") {
      last = { role: "assistant", content: null };
      messages.push(last);
    }
    return last;
  };
  for (const raw of items) {
    const item = object(raw);
    if (item.encrypted_content)
      throw new AdapterProtocolError(
        "Encrypted history from another provider cannot be translated.",
      );
    if (item.type === "message" || (!item.type && item.role)) {
      const role = item.role === "developer" ? "system" : item.role;
      if (!["system", "user", "assistant"].includes(String(role)))
        throw new AdapterProtocolError("Unsupported Responses message role.");
      if (
        role === "assistant" &&
        messages.at(-1)?.role === "assistant" &&
        messages.at(-1)?.content === null
      )
        messages.at(-1)!.content = content(item.content);
      else messages.push({ role, content: content(item.content) });
    } else if (item.type === "function_call") {
      const last = assistant();
      const calls = (last.tool_calls ??= []) as unknown[];
      calls.push({
        id: string(item.call_id),
        type: "function",
        function: {
          name: string(item.name),
          arguments: string(item.arguments),
        },
      });
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: string(item.call_id),
        content: content(item.output),
      });
    } else if (item.type === "reasoning") {
      const parts = item.content ?? item.summary ?? [];
      if (!Array.isArray(parts))
        throw new AdapterProtocolError("Unsupported reasoning history.");
      const text = parts.map((part) => string(object(part).text)).join("");
      if (text) {
        const last = assistant();
        last.reasoning_content = String(last.reasoning_content ?? "") + text;
        // MLX-LM emits `reasoning`; chat templates also commonly consume
        // `reasoning_content`. Preserve both names without placing it in text.
        last.reasoning = last.reasoning_content;
      }
    } else {
      throw new AdapterProtocolError(
        "Unsupported Responses input item for Chat Completions.",
      );
    }
  }
  return messages;
}

export interface ChatCompletionsRequest {
  body: JsonObject;
  validateOutput: (text: string, calls: readonly { name: string }[]) => void;
}

/** Translate the pinned Codex subset. No protocol fallback or request replay. */
export function chatCompletionsRequest(raw: unknown): ChatCompletionsRequest {
  const request = object(raw);
  const allowed = new Set([
    "model",
    "input",
    "instructions",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning",
    "stream",
    "store",
    "include",
    "stream_options",
    "prompt_cache_key",
    "client_metadata",
    "service_tier",
    "temperature",
    "top_p",
    "max_output_tokens",
    "text",
    "metadata",
  ]);
  if (
    Object.entries(request).some(
      ([key, value]) => value != null && !allowed.has(key),
    )
  )
    throw new AdapterProtocolError(
      "Unsupported Responses request field for Chat Completions.",
    );
  const messages = responsesMessages(request.input, request.instructions);
  const tools = request.tools == null ? [] : request.tools;
  if (!Array.isArray(tools))
    throw new AdapterProtocolError("Invalid Responses tools.");
  const chatTools = tools.map((raw) => {
    const tool = object(raw);
    if (tool.type !== "function")
      throw new AdapterProtocolError(
        "Chat Completions requires JSON function tools; custom and server-owned tools are unsupported.",
      );
    return {
      type: "function",
      function: {
        name: string(tool.name),
        ...(tool.description != null
          ? { description: string(tool.description) }
          : {}),
        parameters: object(tool.parameters),
        ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
      },
    };
  });
  const choice = request.tool_choice ?? "auto";
  const namedChoice = typeof choice === "object" ? object(choice) : null;
  if (namedChoice && namedChoice.type !== "function")
    throw new AdapterProtocolError("Unsupported tool choice.");
  if (!namedChoice && !["auto", "none", "required"].includes(String(choice)))
    throw new AdapterProtocolError("Unsupported tool choice.");
  const selectedName = namedChoice ? string(namedChoice.name) : null;
  const reasoning =
    request.reasoning == null ? null : object(request.reasoning);
  // MLX merges these into the model's chat template. Forward the requested
  // effort exactly; the inventory does not invent supported effort levels.
  if (reasoning?.effort != null && typeof reasoning.effort !== "string")
    throw new AdapterProtocolError("Invalid reasoning effort.");
  let outputSchema: z.ZodType | null = null;
  const text = request.text == null ? null : object(request.text);
  if (text?.verbosity != null)
    throw new AdapterProtocolError(
      "MLX-LM does not implement verbosity controls.",
    );
  const format = text?.format == null ? null : object(text.format);
  if (format && format.type !== "text") {
    if (format.type === "json_schema") {
      const schema = object(format.schema);
      try {
        outputSchema = z.fromJSONSchema(
          schema as Parameters<typeof z.fromJSONSchema>[0],
        );
      } catch {
        throw new AdapterProtocolError(
          "This output schema cannot be enforced by the MLX-LM adapter.",
        );
      }
      messages.unshift({
        role: "system",
        content: `Return only JSON satisfying this schema: ${JSON.stringify(schema)}`,
      });
    } else if (format.type === "json_object") {
      outputSchema = z.record(z.string(), z.unknown());
      messages.unshift({
        role: "system",
        content: "Return only a valid JSON object.",
      });
    } else
      throw new AdapterProtocolError("Unsupported structured output format.");
  }
  const body: JsonObject = {
    model: string(request.model),
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(chatTools.length && choice !== "none" ? { tools: chatTools } : {}),
    tool_choice: namedChoice
      ? { type: "function", function: { name: selectedName } }
      : choice,
    ...(typeof request.parallel_tool_calls === "boolean"
      ? { parallel_tool_calls: request.parallel_tool_calls }
      : {}),
    ...(reasoning?.effort
      ? {
          chat_template_kwargs: {
            reasoning_effort: reasoning.effort,
            enable_thinking: reasoning.effort !== "none",
          },
        }
      : {}),
  };
  for (const key of ["temperature", "top_p"])
    if (request[key] != null) body[key] = request[key];
  if (request.max_output_tokens != null)
    body.max_tokens = request.max_output_tokens;
  return {
    body,
    validateOutput(output, calls) {
      if (
        (choice === "required" || selectedName) &&
        !calls.some((call) => !selectedName || call.name === selectedName)
      )
        throw new AdapterProtocolError(
          "The model did not return the required function call.",
        );
      if (choice === "none" && calls.length)
        throw new AdapterProtocolError(
          "The model returned a disallowed function call.",
        );
      if (request.parallel_tool_calls === false && calls.length > 1)
        throw new AdapterProtocolError(
          "The model returned disallowed parallel function calls.",
        );
      if (outputSchema && !calls.length) {
        let value: unknown;
        try {
          value = JSON.parse(output);
        } catch {
          throw new AdapterProtocolError(
            "The model returned invalid structured JSON.",
          );
        }
        if (!outputSchema.safeParse(value).success)
          throw new AdapterProtocolError(
            "The model response did not satisfy the output schema.",
          );
      }
    },
  };
}

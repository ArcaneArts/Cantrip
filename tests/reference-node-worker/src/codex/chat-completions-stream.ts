import { randomUUID } from "node:crypto";
import {
  AdapterProtocolError,
  chatCompletionFailureMessage,
  object,
  type ChatCompletionsRequest,
  type JsonObject,
} from "./chat-completions-request.js";

/** Incremental SSE framing, including CRLF, UTF-8 splits, and multiline data. */
export async function* chatCompletionEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const parse = (value: string) => {
    if (value === "[DONE]") return null;
    try {
      return object(JSON.parse(value));
    } catch {
      throw new AdapterProtocolError(
        "The Chat Completions stream contained invalid JSON.",
      );
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 4 * 1024 * 1024)
        throw new AdapterProtocolError(
          "The Chat Completions stream event exceeded 4 MiB.",
        );
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line && data.length) {
          const event = parse(data.join("\n"));
          data = [];
          if (event === null) return;
          yield event;
        } else if (line.startsWith("data:"))
          data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.reduce((sum, part) => sum + part.length, 0) > 4 * 1024 * 1024)
        throw new AdapterProtocolError(
          "The Chat Completions stream event exceeded 4 MiB.",
        );
      if (done) {
        if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
        if (data.length) {
          const event = parse(data.join("\n"));
          if (event) yield event;
        }
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

interface Item {
  index: number;
  item: JsonObject;
  text: string;
  announced: boolean;
  pendingArguments: string[];
}
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

export class ResponsesCompletionStream {
  readonly id = `resp_${randomUUID()}`;
  readonly #items: Item[] = [];
  readonly #tools = new Map<number, Item>();
  #message: Item | null = null;
  #reasoning: Item | null = null;
  #finishReason: string | null = null;
  #usage: JsonObject | null = null;
  #outputBytes = 0;
  constructor(
    private readonly emit: (event: JsonObject) => void,
    private readonly model: string,
  ) {}

  start() {
    this.emit({
      type: "response.created",
      response: {
        id: this.id,
        object: "response",
        model: this.model,
        status: "in_progress",
        output: [],
      },
    });
  }
  private add(type: string, fields: JsonObject): Item {
    const item: Item = {
      index: this.#items.length,
      item: { id: `${type}_${randomUUID()}`, type, ...fields },
      text: "",
      announced: false,
      pendingArguments: [],
    };
    this.#items.push(item);
    return item;
  }
  private announce(item: Item) {
    if (item.announced) return;
    if (
      item.item.type === "function_call" &&
      (!item.item.name || !item.item.call_id)
    )
      return;
    item.announced = true;
    this.emit({
      type: "response.output_item.added",
      output_index: item.index,
      item: { ...item.item },
    });
    for (const delta of item.pendingArguments)
      this.emit({
        type: "response.function_call_arguments.delta",
        item_id: item.item.id,
        output_index: item.index,
        delta,
      });
    item.pendingArguments = [];
  }
  private append(item: Item, value: unknown, type: string) {
    if (typeof value !== "string")
      throw new AdapterProtocolError(
        "The model returned non-text stream content.",
      );
    this.#outputBytes += Buffer.byteLength(value);
    if (this.#outputBytes > 64 * 1024 * 1024)
      throw new AdapterProtocolError("The model output exceeded 64 MiB.");
    item.text += value;
    this.announce(item);
    this.emit({
      type,
      item_id: item.item.id,
      output_index: item.index,
      content_index: 0,
      delta: value,
    });
  }
  accept(raw: unknown) {
    const packet = object(raw);
    if (packet.error) {
      const error =
        typeof packet.error === "string"
          ? packet.error
          : JSON.stringify(packet.error);
      throw new AdapterProtocolError(chatCompletionFailureMessage(error));
    }
    if (packet.usage != null) {
      const usage = object(packet.usage);
      const input = count(usage.prompt_tokens),
        output = count(usage.completion_tokens);
      if (input !== null && output !== null) {
        const details =
          usage.prompt_tokens_details == null
            ? null
            : object(usage.prompt_tokens_details);
        const cached = details ? count(details.cached_tokens) : null;
        this.#usage = {
          input_tokens: input,
          output_tokens: output,
          total_tokens: count(usage.total_tokens) ?? input + output,
          ...(cached !== null && cached !== undefined
            ? { input_tokens_details: { cached_tokens: cached } }
            : {}),
          ...(usage.completion_tokens_details
            ? { output_tokens_details: usage.completion_tokens_details }
            : {}),
        };
      }
    }
    if (!Array.isArray(packet.choices))
      throw new AdapterProtocolError(
        "The provider returned no Chat Completions choices.",
      );
    if (packet.choices.length > 1)
      throw new AdapterProtocolError(
        "Multiple completion choices are unsupported.",
      );
    for (const rawChoice of packet.choices) {
      const choice = object(rawChoice);
      const delta = object(choice.delta ?? choice.message ?? {});
      if (delta.refusal)
        throw new AdapterProtocolError(
          "The model refused the inference request.",
        );
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning != null && reasoning !== "") {
        this.#reasoning ??= this.add("reasoning", {
          summary: [],
          content: [],
          encrypted_content: null,
        });
        this.append(
          this.#reasoning,
          reasoning,
          "response.reasoning_text.delta",
        );
      }
      if (delta.content != null && delta.content !== "") {
        this.#message ??= this.add("message", {
          role: "assistant",
          status: "in_progress",
          content: [],
        });
        this.append(this.#message, delta.content, "response.output_text.delta");
      }
      if (delta.tool_calls != null) {
        if (!Array.isArray(delta.tool_calls))
          throw new AdapterProtocolError("Invalid streamed function calls.");
        for (const [position, rawTool] of delta.tool_calls.entries()) {
          const tool = object(rawTool);
          if (tool.type != null && tool.type !== "function")
            throw new AdapterProtocolError(
              "The provider returned an unsupported tool type.",
            );
          const index = tool.index ?? position;
          if (!Number.isSafeInteger(index) || Number(index) < 0)
            throw new AdapterProtocolError("Invalid streamed function index.");
          let state = this.#tools.get(Number(index));
          if (!state) {
            state = this.add("function_call", {
              call_id: "",
              name: "",
              arguments: "",
            });
            this.#tools.set(Number(index), state);
          }
          if (tool.id != null) {
            if (
              typeof tool.id !== "string" ||
              !tool.id ||
              (state.item.call_id && state.item.call_id !== tool.id)
            )
              throw new AdapterProtocolError(
                "Inconsistent streamed function ID.",
              );
            state.item.call_id = tool.id;
          }
          const fn = object(tool.function ?? {});
          if (fn.name != null) {
            if (typeof fn.name !== "string")
              throw new AdapterProtocolError("Invalid streamed function name.");
            state.item.name = String(state.item.name) + fn.name;
          }
          this.announce(state);
          if (fn.arguments != null) {
            if (typeof fn.arguments !== "string")
              throw new AdapterProtocolError(
                "Invalid streamed function arguments.",
              );
            state.item.arguments = String(state.item.arguments) + fn.arguments;
            this.#outputBytes += Buffer.byteLength(fn.arguments);
            if (this.#outputBytes > 64 * 1024 * 1024)
              throw new AdapterProtocolError(
                "The model output exceeded 64 MiB.",
              );
            if (state.announced)
              this.emit({
                type: "response.function_call_arguments.delta",
                item_id: state.item.id,
                output_index: state.index,
                delta: fn.arguments,
              });
            else state.pendingArguments.push(fn.arguments);
          }
        }
      }
      if (choice.finish_reason != null) {
        if (this.#finishReason)
          throw new AdapterProtocolError(
            "The provider returned multiple completion terminators.",
          );
        this.#finishReason = String(choice.finish_reason);
      }
    }
  }

  finish(request: ChatCompletionsRequest): JsonObject {
    if (!this.#finishReason)
      throw new AdapterProtocolError(
        "The Chat Completions stream ended before completion.",
      );
    if (!["stop", "tool_calls", "length"].includes(this.#finishReason))
      throw new AdapterProtocolError(
        "The provider stopped inference unsuccessfully.",
      );
    const calls = [...this.#tools.values()].map(({ item }) => ({
      name: String(item.name),
    }));
    if (this.#finishReason === "length" && calls.length)
      throw new AdapterProtocolError("The model truncated a function call.");
    if (this.#finishReason !== "length")
      request.validateOutput(this.#message?.text ?? "", calls);
    for (const state of this.#items) {
      const item = state.item;
      if (item.type === "function_call") {
        if (!item.name)
          throw new AdapterProtocolError(
            "The model returned an unnamed function call.",
          );
        item.call_id ||= `call_${randomUUID()}`;
        this.announce(state);
        this.emit({
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: state.index,
          arguments: item.arguments,
        });
      } else if (item.type === "message") {
        item.content = [
          { type: "output_text", text: state.text, annotations: [] },
        ];
        item.status = "completed";
        this.emit({
          type: "response.output_text.done",
          item_id: item.id,
          output_index: state.index,
          content_index: 0,
          text: state.text,
        });
      } else {
        item.content = [{ type: "reasoning_text", text: state.text }];
        this.emit({
          type: "response.reasoning_text.done",
          item_id: item.id,
          output_index: state.index,
          content_index: 0,
          text: state.text,
        });
      }
      this.emit({
        type: "response.output_item.done",
        output_index: state.index,
        item,
      });
    }
    const incomplete = this.#finishReason === "length";
    const result: JsonObject = {
      id: this.id,
      object: "response",
      model: this.model,
      status: incomplete ? "incomplete" : "completed",
      output: this.#items.map(({ item }) => item),
      ...(incomplete
        ? { incomplete_details: { reason: "max_output_tokens" } }
        : {}),
      ...(this.#usage ? { usage: this.#usage } : {}),
    };
    this.emit({
      type: incomplete ? "response.incomplete" : "response.completed",
      response: result,
    });
    return result;
  }
}

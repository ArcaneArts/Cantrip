import { randomBytes } from "node:crypto";

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import {
  cantripMcpWebReadInputSchema,
  cantripMcpWebReadResultSchema,
  cantripMcpWebSearchInputSchema,
  cantripMcpWebSearchResultSchema,
  type CantripAgentOperationResult,
  type CantripMcpBinding,
} from "@cantrip/protocol";

import type { SearxngRuntimeManager } from "../managed-runtimes/searxng.js";
import { RobotsPolicy } from "./robots.js";
import {
  normalizedPublicHttpUrl,
  safeFetch,
  type SafeFetchOptions,
} from "./safe-fetch.js";

const SEARCH_REFERENCE_TTL_MS = 15 * 60_000;
const READ_CURSOR_TTL_MS = 10 * 60_000;
const MAX_REFERENCES = 5_000;
const MAX_READ_CURSORS = 100;
const MAX_STORED_DOCUMENT_CHARS = 1_000_000;
const RATE_WINDOW_MS = 60_000;
const SEARCHES_PER_WINDOW = 30;
const READS_PER_WINDOW = 60;

interface SearchReference {
  chatId: string;
  expiresAt: number;
  ownerId: string;
  url: string;
}

interface ReadCursor {
  chatId: string;
  content: string;
  expiresAt: number;
  method: "plain-text" | "rendered" | "static";
  offset: number;
  ownerId: string;
  retrievedAt: string;
  title: string;
  url: string;
}

interface RateWindow {
  count: number;
  expiresAt: number;
}

interface SearxngPayload {
  query?: unknown;
  results?: unknown;
  unresponsive_engines?: unknown;
}

interface SearxngResult {
  content?: unknown;
  engines?: unknown;
  publishedDate?: unknown;
  title?: unknown;
  url?: unknown;
}

export interface WorkerWebServiceOptions {
  fetchPage?: typeof safeFetch;
  fetchOptions?: SafeFetchOptions;
  now?: () => Date;
  robots?: RobotsPolicy;
  renderPage?: (
    url: string,
    beforeNavigation?: (url: URL) => Promise<void>,
  ) => Promise<{ html: string; title: string; url: string }>;
  searchRuntime: Pick<SearxngRuntimeManager, "request">;
}

function opaque(prefix: "wrc" | "wsr"): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function compactText(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function bindingKey(binding: CantripMcpBinding): {
  chatId: string;
  ownerId: string;
} {
  return { chatId: binding.chatId, ownerId: binding.ownerId };
}

function belongsTo(
  record: { chatId: string; ownerId: string },
  binding: CantripMcpBinding,
): boolean {
  return record.ownerId === binding.ownerId && record.chatId === binding.chatId;
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function publishedAt(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return null;
  return new Date(value).toISOString();
}

function engineDiagnostic(value: unknown) {
  if (!Array.isArray(value) || typeof value[0] !== "string") return null;
  const raw = compactText(value[1], 200).toLowerCase();
  const category = raw.includes("captcha")
    ? "captcha"
    : raw.includes("rate") || raw.includes("429")
      ? "rate-limited"
      : raw.includes("timeout")
        ? "timeout"
        : raw.includes("network") || raw.includes("connect")
          ? "unavailable"
          : "unknown";
  return {
    engine: value[0].slice(0, 100),
    category,
    message: `The ${value[0].slice(0, 100)} engine was ${category.replace("-", " ")}.`,
  } as const;
}

function extractionFromHtml(html: string, url: string) {
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document, {
    charThreshold: 100,
  }).parse();
  const canonicalValue = document
    .querySelector('link[rel~="canonical"]')
    ?.getAttribute("href");
  let canonical = url;
  if (canonicalValue) {
    try {
      canonical = normalizedPublicHttpUrl(
        new URL(canonicalValue, url).href,
      ).href;
    } catch {}
  }
  const content = compactText(
    article?.textContent ?? document.body?.textContent,
    MAX_STORED_DOCUMENT_CHARS,
  );
  return {
    content,
    title: compactText(article?.title ?? document.title, 1_000),
    url: canonical,
  };
}

function decodedBody(body: Buffer, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? "utf-8", { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
  }
}

export class WorkerWebService {
  readonly #fetchPage: typeof safeFetch;
  readonly #fetchOptions: SafeFetchOptions;
  readonly #now: () => Date;
  readonly #readCursors = new Map<string, ReadCursor>();
  readonly #references = new Map<string, SearchReference>();
  readonly #renderPage:
    | ((
        url: string,
        beforeNavigation?: (url: URL) => Promise<void>,
      ) => Promise<{ html: string; title: string; url: string }>)
    | null;
  readonly #rateWindows = new Map<string, RateWindow>();
  readonly #robots: RobotsPolicy;
  readonly #searchRuntime: WorkerWebServiceOptions["searchRuntime"];

  constructor(options: WorkerWebServiceOptions) {
    this.#fetchPage = options.fetchPage ?? safeFetch;
    this.#fetchOptions = options.fetchOptions ?? {};
    this.#now = options.now ?? (() => new Date());
    this.#robots =
      options.robots ?? new RobotsPolicy({ fetchOptions: this.#fetchOptions });
    this.#renderPage = options.renderPage ?? null;
    this.#searchRuntime = options.searchRuntime;
  }

  async search(
    binding: CantripMcpBinding,
    arguments_: unknown,
  ): Promise<CantripAgentOperationResult> {
    const input = cantripMcpWebSearchInputSchema.parse(arguments_);
    this.#expire();
    this.#consumeBudget(binding, "search", SEARCHES_PER_WINDOW);
    const query = [
      input.query,
      input.includeDomains.length > 0
        ? `(${input.includeDomains.map((domain) => `site:${domain}`).join(" OR ")})`
        : "",
      ...input.excludeDomains.map((domain) => `-site:${domain}`),
    ]
      .filter(Boolean)
      .join(" ");
    const parameters = new URLSearchParams({
      categories: input.category,
      format: "json",
      language: input.language ?? "auto",
      pageno: String(input.page),
      q: query,
      safesearch: String({ off: 0, moderate: 1, strict: 2 }[input.safeSearch]),
    });
    if (input.freshness) parameters.set("time_range", input.freshness);
    const payload = (await this.#searchRuntime.request(
      "/search",
      parameters,
      30_000,
    )) as SearxngPayload;
    const rawResults = Array.isArray(payload.results)
      ? (payload.results as SearxngResult[])
      : [];
    const normalized = [];
    const seenUrls = new Set<string>();
    for (const result of rawResults) {
      if (normalized.length >= input.count) break;
      if (typeof result.url !== "string") continue;
      let url: URL;
      try {
        url = normalizedPublicHttpUrl(result.url);
      } catch {
        continue;
      }
      if (seenUrls.has(url.href)) continue;
      if (
        (input.includeDomains.length > 0 &&
          !input.includeDomains.some((domain) =>
            domainMatches(url.hostname, domain),
          )) ||
        input.excludeDomains.some((domain) =>
          domainMatches(url.hostname, domain),
        )
      ) {
        continue;
      }
      seenUrls.add(url.href);
      const id = opaque("wsr");
      this.#references.set(id, {
        ...bindingKey(binding),
        expiresAt: this.#now().getTime() + SEARCH_REFERENCE_TTL_MS,
        url: url.href,
      });
      normalized.push({
        id,
        title: compactText(result.title, 1_000),
        url: url.href,
        snippet: compactText(result.content, 4_000),
        engines: Array.isArray(result.engines)
          ? result.engines
              .filter((engine): engine is string => typeof engine === "string")
              .slice(0, 10)
          : [],
        publishedAt: publishedAt(result.publishedDate),
      });
    }
    const diagnostics = Array.isArray(payload.unresponsive_engines)
      ? payload.unresponsive_engines
          .map(engineDiagnostic)
          .filter((item) => item !== null)
          .slice(0, 10)
      : [];
    this.#bound(this.#references);
    return cantripMcpWebSearchResultSchema.parse({
      summary: `Search returned ${normalized.length} result${normalized.length === 1 ? "" : "s"}${diagnostics.length > 0 ? ` with ${diagnostics.length} partial engine failure${diagnostics.length === 1 ? "" : "s"}` : ""}.`,
      target: null,
      worktreeId: null,
      continuationScheduled: false,
      mutated: false,
      data: {
        query: compactText(payload.query, 500) || input.query,
        results: normalized,
        diagnostics,
        truncated: rawResults.length > normalized.length,
      },
    });
  }

  async read(
    binding: CantripMcpBinding,
    arguments_: unknown,
  ): Promise<CantripAgentOperationResult> {
    const input = cantripMcpWebReadInputSchema.parse(arguments_);
    this.#expire();
    this.#consumeBudget(binding, "read", READS_PER_WINDOW);
    if (input.cursor)
      return this.#continueRead(binding, input.cursor, input.maxChars);
    let urlValue = input.url;
    if (input.searchResultId) {
      const reference = this.#references.get(input.searchResultId);
      if (!reference || !belongsTo(reference, binding))
        throw new Error(
          "Search result reference is expired or belongs to another task.",
        );
      urlValue = reference.url;
    }
    const url = normalizedPublicHttpUrl(urlValue!);
    await this.#robots.assertAllowed(url);
    if (input.render === "always")
      return await this.#render(binding, url.href, input.maxChars);
    const response = await this.#fetchPage(url.href, {
      ...this.#fetchOptions,
      beforeRequest: async (candidate) => {
        await this.#robots.assertAllowed(candidate);
      },
      contentTypes: [
        "application/xhtml+xml",
        "text/html",
        "text/markdown",
        "text/plain",
        "text/x-markdown",
      ],
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Web read returned HTTP ${response.status}.`);
    }
    let extracted: { content: string; title: string; url: string };
    let method: "plain-text" | "static";
    if (["text/html", "application/xhtml+xml"].includes(response.contentType)) {
      extracted = extractionFromHtml(
        decodedBody(response.body, response.charset),
        response.url,
      );
      method = "static";
    } else if (
      ["text/plain", "text/markdown", "text/x-markdown"].includes(
        response.contentType,
      )
    ) {
      extracted = {
        content: compactText(
          decodedBody(response.body, response.charset),
          MAX_STORED_DOCUMENT_CHARS,
        ),
        title: "",
        url: response.url,
      };
      method = "plain-text";
    } else {
      throw new Error(
        `Web read does not support content type ${response.contentType || "unknown"}.`,
      );
    }
    if (extracted.content.length < 100 && input.render === "auto") {
      return await this.#render(binding, response.url, input.maxChars);
    }
    const retrievedAt = this.#now().toISOString();
    return this.#page(
      binding,
      { ...extracted, method, retrievedAt },
      0,
      input.maxChars,
    );
  }

  async #render(
    binding: CantripMcpBinding,
    url: string,
    maxChars: number,
  ): Promise<CantripAgentOperationResult> {
    if (!this.#renderPage)
      throw new Error("Rendered reading is unavailable on this worker.");
    const rendered = await this.#renderPage(url, async (candidate) => {
      await this.#robots.assertAllowed(candidate);
    });
    const extracted = extractionFromHtml(rendered.html, rendered.url);
    if (!extracted.title) extracted.title = compactText(rendered.title, 1_000);
    if (extracted.content.length < 1)
      throw new Error("Rendered reading found no usable page content.");
    return this.#page(
      binding,
      {
        ...extracted,
        method: "rendered",
        retrievedAt: this.#now().toISOString(),
      },
      0,
      maxChars,
    );
  }

  #continueRead(
    binding: CantripMcpBinding,
    cursorId: string,
    maxChars: number,
  ): CantripAgentOperationResult {
    const cursor = this.#readCursors.get(cursorId);
    this.#readCursors.delete(cursorId);
    if (!cursor || !belongsTo(cursor, binding))
      throw new Error("Web read cursor is expired or belongs to another task.");
    return this.#page(binding, cursor, cursor.offset, maxChars);
  }

  #page(
    binding: CantripMcpBinding,
    document: Omit<ReadCursor, "chatId" | "expiresAt" | "offset" | "ownerId">,
    offset: number,
    maxChars: number,
  ): CantripAgentOperationResult {
    const content = document.content.slice(offset, offset + maxChars);
    const nextOffset = offset + content.length;
    const truncated = nextOffset < document.content.length;
    const cursor = truncated ? opaque("wrc") : null;
    if (cursor) {
      this.#readCursors.set(cursor, {
        ...document,
        ...bindingKey(binding),
        expiresAt: this.#now().getTime() + READ_CURSOR_TTL_MS,
        offset: nextOffset,
      });
      this.#bound(this.#readCursors, MAX_READ_CURSORS);
    }
    return cantripMcpWebReadResultSchema.parse({
      summary: `Read ${content.length} character${content.length === 1 ? "" : "s"}${truncated ? "; more content is available" : ""}.`,
      target: null,
      worktreeId: null,
      continuationScheduled: false,
      mutated: false,
      data: {
        url: document.url,
        title: document.title,
        content,
        method: document.method,
        retrievedAt: document.retrievedAt,
        cursor,
        truncated,
      },
    });
  }

  #expire(): void {
    const now = this.#now().getTime();
    for (const [id, record] of this.#references)
      if (record.expiresAt <= now) this.#references.delete(id);
    for (const [id, record] of this.#readCursors)
      if (record.expiresAt <= now) this.#readCursors.delete(id);
    for (const [key, window] of this.#rateWindows)
      if (window.expiresAt <= now) this.#rateWindows.delete(key);
  }

  #consumeBudget(
    binding: CantripMcpBinding,
    operation: "read" | "search",
    limit: number,
  ): void {
    const now = this.#now().getTime();
    const key = `${binding.ownerId}\u0000${binding.chatId}\u0000${operation}`;
    const current = this.#rateWindows.get(key);
    if (!current || current.expiresAt <= now) {
      this.#rateWindows.set(key, { count: 1, expiresAt: now + RATE_WINDOW_MS });
      return;
    }
    if (current.count >= limit) {
      throw new Error(
        `Web ${operation} rate limit reached. Retry after ${new Date(current.expiresAt).toISOString()}.`,
      );
    }
    current.count += 1;
  }

  #bound<T extends { expiresAt: number }>(
    records: Map<string, T>,
    limit = MAX_REFERENCES,
  ): void {
    while (records.size > limit) records.delete(records.keys().next().value!);
  }
}

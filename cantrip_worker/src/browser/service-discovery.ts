import { execFile } from "node:child_process";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  browserServiceListSchema,
  type BrowserService,
  type BrowserServiceProtocol,
} from "@cantrip/protocol";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 3_000;
const PROBE_TIMEOUT_MS = 750;
const MAX_CANDIDATES = 128;
const PROBE_CONCURRENCY = 24;
const MAX_TITLE_BYTES = 64 * 1_024;

export interface ListeningPortCandidate {
  host: string;
  port: number;
  pid: number | null;
  processName: string | null;
  command: string | null;
}

async function commandOutput(
  command: string,
  arguments_: string[],
): Promise<string> {
  try {
    const result = await execFileAsync(command, arguments_, {
      encoding: "utf8",
      maxBuffer: 4 * 1_024 * 1_024,
      timeout: COMMAND_TIMEOUT_MS,
    });
    return String(result.stdout);
  } catch {
    return "";
  }
}

function normalizeListenerHost(value: string): string | null {
  const host = value.trim().replace(/^TCP\s+/u, "");
  if (!host) return null;
  if (host === "*" || host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "::1";
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

function parseListenerAddress(
  value: string,
): Pick<ListeningPortCandidate, "host" | "port"> | null {
  const address = value.trim().replace(/\s+\(LISTEN\)$/u, "");
  const bracketed = address.match(/^\[([0-9a-f:.%]+)\]:(\d+)$/iu);
  const match = bracketed ?? address.match(/^(.*):(\d+)$/u);
  if (!match) return null;
  const host = normalizeListenerHost(match[1] ?? "");
  const port = Number(match[2]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  return { host, port };
}

export function parseLsofListeners(output: string): ListeningPortCandidate[] {
  const listeners: ListeningPortCandidate[] = [];
  let pid: number | null = null;
  let processName: string | null = null;
  for (const line of output.split(/\r?\n/u)) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      const parsed = Number(value);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      processName = null;
    } else if (field === "c") {
      processName = value.trim() || null;
    } else if (field === "n") {
      const address = parseListenerAddress(value);
      if (!address) continue;
      listeners.push({
        ...address,
        pid,
        processName,
        command: null,
      });
    }
  }
  return listeners;
}

export function parseSsListeners(output: string): ListeningPortCandidate[] {
  const listeners: ListeningPortCandidate[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    if (columns.length < 4) continue;
    const address = parseListenerAddress(columns[3] ?? "");
    if (!address) continue;
    const process = line.match(/\(\("([^"]+)",pid=(\d+)/u);
    listeners.push({
      ...address,
      pid: process?.[2] ? Number(process[2]) : null,
      processName: process?.[1] ?? null,
      command: null,
    });
  }
  return listeners;
}

export function parseNetstatListeners(
  output: string,
): ListeningPortCandidate[] {
  const listeners: ListeningPortCandidate[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    if (
      columns.length < 5 ||
      columns[0]?.toUpperCase() !== "TCP" ||
      columns.at(-2)?.toUpperCase() !== "LISTENING"
    ) {
      continue;
    }
    const address = parseListenerAddress(columns[1] ?? "");
    if (!address) continue;
    const parsedPid = Number(columns.at(-1));
    listeners.push({
      ...address,
      pid: Number.isInteger(parsedPid) && parsedPid > 0 ? parsedPid : null,
      processName: null,
      command: null,
    });
  }
  return listeners;
}

function normalizedExecutableName(value: string | null): string | null {
  if (!value) return null;
  const name = path
    .basename(value)
    .replace(/\.exe$/iu, "")
    .trim();
  return name || null;
}

export function classifyServiceProcess(
  command: string | null,
  executable: string | null,
): string | null {
  const text = `${command ?? ""} ${executable ?? ""}`.toLowerCase();
  const known: Array<[RegExp, string]> = [
    [/(?:^|[\s/\\])vite(?:\.js)?(?:$|[\s/\\])/u, "Vite"],
    [/(?:^|[\s/\\])next(?:\.js)?(?:$|[\s/\\])/u, "Next.js"],
    [/(?:^|[\s/\\])nuxt(?:$|[\s/\\])/u, "Nuxt"],
    [/(?:^|[\s/\\])astro(?:$|[\s/\\])/u, "Astro"],
    [/webpack(?:-dev-server)?/u, "Webpack"],
    [/(?:ng serve|angular-cli)/u, "Angular"],
    [/(?:react-scripts|react-router dev)/u, "React"],
    [/(?:^|[\s/\\])remix(?:$|[\s/\\])/u, "Remix"],
    [/(?:svelte-kit|sveltekit)/u, "SvelteKit"],
    [/(?:vue-cli-service|vue dev)/u, "Vue"],
    [/(?:django|manage\.py runserver)/u, "Django"],
    [/(?:flask|werkzeug)/u, "Flask"],
    [/uvicorn/u, "Uvicorn"],
    [/gunicorn/u, "Gunicorn"],
    [/(?:rails server|puma)/u, "Rails"],
    [/(?:php artisan serve|laravel)/u, "Laravel"],
  ];
  for (const [pattern, name] of known) {
    if (pattern.test(text)) return name;
  }
  const fallback = normalizedExecutableName(executable);
  if (!fallback) return null;
  if (/^node(?:js)?$/iu.test(fallback)) return "Node.js";
  if (/^python\d*(?:\.\d+)?$/iu.test(fallback)) return "Python";
  if (/^ruby$/iu.test(fallback)) return "Ruby";
  if (/^java$/iu.test(fallback)) return "Java";
  if (/^bun$/iu.test(fallback)) return "Bun";
  if (/^deno$/iu.test(fallback)) return "Deno";
  if (/^php$/iu.test(fallback)) return "PHP";
  return fallback.slice(0, 200);
}

function parseProcessCommands(output: string): Map<number, string> {
  const commands = new Map<number, string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    if (match?.[1] && match[2]) commands.set(Number(match[1]), match[2]);
  }
  return commands;
}

async function enrichProcessCommands(
  candidates: ListeningPortCandidate[],
): Promise<ListeningPortCandidate[]> {
  if (platform() === "win32") return candidates;
  const pids = [
    ...new Set(
      candidates
        .map(({ pid }) => pid)
        .filter((pid): pid is number => pid !== null),
    ),
  ].slice(0, MAX_CANDIDATES);
  if (pids.length === 0) return candidates;
  const output = await commandOutput("ps", [
    "-p",
    pids.join(","),
    "-o",
    "pid=",
    "-o",
    "command=",
  ]);
  const commands = parseProcessCommands(output);
  return candidates.map((candidate) => ({
    ...candidate,
    command: candidate.pid ? (commands.get(candidate.pid) ?? null) : null,
  }));
}

async function collectListeningPorts(): Promise<ListeningPortCandidate[]> {
  let candidates: ListeningPortCandidate[] = [];
  if (platform() === "win32") {
    candidates = parseNetstatListeners(
      await commandOutput("netstat", ["-ano", "-p", "tcp"]),
    );
  } else {
    candidates = parseLsofListeners(
      await commandOutput("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]),
    );
    if (candidates.length === 0 && platform() === "linux") {
      candidates = parseSsListeners(await commandOutput("ss", ["-H", "-ltnp"]));
    }
  }

  const unique = new Map<string, ListeningPortCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.host}\0${candidate.port}`;
    const previous = unique.get(key);
    if (!previous || (!previous.pid && candidate.pid)) {
      unique.set(key, candidate);
    }
  }
  return enrichProcessCommands(
    [...unique.values()]
      .sort((left, right) => left.port - right.port)
      .slice(0, MAX_CANDIDATES),
  );
}

function serviceUrl(
  protocol: BrowserServiceProtocol,
  host: string,
  port: number,
): string {
  const urlHost = host.includes(":")
    ? `[${host.replaceAll("%", "%25")}]`
    : host;
  return `${protocol}://${urlHost}:${port}/`;
}

function decodeHtmlTitle(value: string): string | null {
  const title = value
    .replace(/<[^>]+>/gu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#(?:39|x27);/giu, "'")
    .replace(/\s+/gu, " ")
    .trim();
  return title ? title.slice(0, 200) : null;
}

function htmlTitle(content: string): string | null {
  const match = content.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/iu);
  return match?.[1] ? decodeHtmlTitle(match[1]) : null;
}

async function probeProtocol(
  candidate: ListeningPortCandidate,
  protocol: BrowserServiceProtocol,
  workerId: string,
): Promise<BrowserService | null> {
  return new Promise((resolve) => {
    let settled = false;
    let body = "";
    const finish = (service: BrowserService | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(service);
    };
    const request = (protocol === "https" ? requestHttps : requestHttp)(
      {
        hostname: candidate.host,
        port: candidate.port,
        path: "/",
        method: "GET",
        headers: {
          Accept: "text/html,application/json,text/plain,*/*;q=0.5",
          "User-Agent": "Cantrip-Service-Discovery/1.0",
        },
        ...(protocol === "https" ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        const statusCode = response.statusCode;
        if (!statusCode || statusCode < 100 || statusCode > 599) {
          response.destroy();
          finish(null);
          return;
        }
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (body.length < MAX_TITLE_BYTES) {
            body += chunk.slice(0, MAX_TITLE_BYTES - body.length);
          }
          if (body.length >= MAX_TITLE_BYTES) response.destroy();
        });
        const complete = () =>
          finish({
            workerId,
            host: candidate.host,
            port: candidate.port,
            protocol,
            url: serviceUrl(protocol, candidate.host, candidate.port),
            title: htmlTitle(body),
            processName: classifyServiceProcess(
              candidate.command,
              candidate.processName,
            ),
            statusCode,
          });
        response.on("end", complete);
        response.on("close", complete);
      },
    );
    const deadline = setTimeout(() => {
      request.destroy();
      finish(null);
    }, PROBE_TIMEOUT_MS);
    request.on("error", () => finish(null));
    request.end();
  });
}

async function probeCandidate(
  candidate: ListeningPortCandidate,
  workerId: string,
): Promise<BrowserService | null> {
  return (
    (await probeProtocol(candidate, "http", workerId)) ??
    (await probeProtocol(candidate, "https", workerId))
  );
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await operation(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function discoverBrowserServices(options: {
  workerId: string;
  candidates?: ListeningPortCandidate[];
  probe?: (candidate: ListeningPortCandidate) => Promise<BrowserService | null>;
}): Promise<BrowserService[]> {
  const candidates = options.candidates ?? (await collectListeningPorts());
  const services = await mapConcurrent(
    candidates.slice(0, MAX_CANDIDATES),
    PROBE_CONCURRENCY,
    options.probe ??
      ((candidate) => probeCandidate(candidate, options.workerId)),
  );
  return browserServiceListSchema.parse(
    services
      .filter((service): service is BrowserService => service !== null)
      .sort(
        (left, right) =>
          left.port - right.port || left.url.localeCompare(right.url),
      ),
  );
}

import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import { Agent, request } from "undici";

const MAX_REDIRECTS = 5;
const MAX_COMPRESSED_BYTES = 5_000_000;
const MAX_EXPANDED_BYTES = 10_000_000;
const TOTAL_TIMEOUT_MS = 30_000;
const blocked = new BlockList();

class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: Array<(release: () => void) => void> = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  get idle(): boolean {
    return this.#active === 0 && this.#waiting.length === 0;
  }

  async acquire(): Promise<() => void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return this.#release();
    }
    return await new Promise((resolve) => this.#waiting.push(resolve));
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiting.shift();
      if (next) next(this.#release());
      else this.#active -= 1;
    };
  }
}

const globalRequests = new Semaphore(8);
const hostRequests = new Map<string, Semaphore>();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

export interface SafeFetchOptions {
  beforeRequest?: (url: URL) => Promise<void>;
  contentTypes?: readonly string[];
  compressedByteLimit?: number;
  expandedByteLimit?: number;
  lookup?: typeof dnsLookup;
  method?: "GET";
  request?: typeof request;
  timeoutMs?: number;
}

export interface SafeFetchResponse {
  body: Buffer;
  charset: string | null;
  contentType: string;
  headers: Record<string, string | string[] | undefined>;
  status: number;
  url: string;
}

export function normalizedPublicHttpUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Web reads accept only HTTP and HTTPS URLs.");
  }
  if (url.username || url.password) {
    throw new Error("Web URLs cannot contain credentials.");
  }
  if (
    (url.protocol === "http:" && url.port && url.port !== "80") ||
    (url.protocol === "https:" && url.port && url.port !== "443")
  ) {
    throw new Error("Web reads accept only standard HTTP and HTTPS ports.");
  }
  url.hash = "";
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "metadata.google.internal"
  ) {
    throw new Error("Web reads cannot access local or private hosts.");
  }
  return url;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = mappedIpv4(address);
    return mapped ? isPublicAddress(mapped) : !blocked.check(address, "ipv6");
  }
  return false;
}

function mappedIpv4(address: string): string | null {
  const normalized = address.toLowerCase();
  if (!normalized.startsWith("::ffff:")) return null;
  const suffix = normalized.slice("::ffff:".length);
  if (isIP(suffix) === 4) return suffix;
  const groups = suffix.split(":");
  if (
    groups.length !== 2 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))
  )
    return null;
  const high = Number.parseInt(groups[0]!, 16);
  const low = Number.parseInt(groups[1]!, 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

async function publicAddresses(
  hostname: string,
  lookup: typeof dnsLookup,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  hostname =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) {
      throw new Error("Web reads cannot access local or private addresses.");
    }
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new Error(
      "Web reads cannot access hosts resolving to local or private addresses.",
    );
  }
  return addresses.map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }));
}

function expandedBody(
  compressed: Buffer,
  encoding: string | undefined,
  limit: number,
): Buffer {
  const normalized = encoding?.split(",")[0]?.trim().toLowerCase();
  const options = { maxOutputLength: limit };
  if (!normalized || normalized === "identity") return compressed;
  if (normalized === "gzip" || normalized === "x-gzip")
    return gunzipSync(compressed, options);
  if (normalized === "deflate") return inflateSync(compressed, options);
  if (normalized === "br") return brotliDecompressSync(compressed, options);
  throw new Error(`Unsupported web response encoding: ${normalized}`);
}

export async function safeFetch(
  input: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  const compressedLimit = options.compressedByteLimit ?? MAX_COMPRESSED_BYTES;
  const expandedLimit = options.expandedByteLimit ?? MAX_EXPANDED_BYTES;
  const lookup = options.lookup ?? dnsLookup;
  const requestImplementation = options.request ?? request;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? TOTAL_TIMEOUT_MS,
  );
  timer.unref();
  let current = normalizedPublicHttpUrl(input);
  const releaseGlobal = await globalRequests.acquire();
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const requestHostname = current.hostname;
      const hostSemaphore =
        hostRequests.get(requestHostname) ?? new Semaphore(2);
      hostRequests.set(requestHostname, hostSemaphore);
      const releaseHost = await hostSemaphore.acquire();
      try {
        await options.beforeRequest?.(new URL(current.href));
        const addresses = await publicAddresses(current.hostname, lookup);
        const selected = addresses[0]!;
        const dispatcher = new Agent({
          connect: {
            timeout: 5_000,
            lookup(_hostname, lookupOptions, callback) {
              if (lookupOptions.all) {
                callback(null, [selected]);
              } else {
                callback(null, selected.address, selected.family);
              }
            },
          },
        });
        try {
          const response = await requestImplementation(current, {
            dispatcher,
            headers: {
              accept:
                "text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.1",
              "accept-encoding": "gzip, deflate, br",
              "user-agent":
                "CantripResearchBot/1.0 (+https://github.com/ArcaneArts/Cantrip)",
            },
            headersTimeout: 10_000,
            bodyTimeout: 10_000,
            method: options.method ?? "GET",
            signal: controller.signal,
          });
          const location = response.headers.location;
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            location
          ) {
            let redirectBytes = 0;
            for await (const chunk of response.body) {
              redirectBytes += Buffer.byteLength(chunk);
              if (redirectBytes > compressedLimit) {
                response.body.destroy();
                throw new Error(
                  "Web redirect response exceeds the compressed byte limit.",
                );
              }
            }
            if (redirect === MAX_REDIRECTS)
              throw new Error("Web response exceeded the redirect limit.");
            const redirected = normalizedPublicHttpUrl(
              new URL(
                Array.isArray(location) ? location[0]! : location,
                current,
              ).href,
            );
            if (
              current.protocol === "https:" &&
              redirected.protocol !== "https:"
            ) {
              throw new Error("Web redirects cannot downgrade HTTPS to HTTP.");
            }
            current = redirected;
            continue;
          }
          const rawContentType = String(response.headers["content-type"] ?? "");
          const contentType = rawContentType
            .split(";", 1)[0]!
            .trim()
            .toLowerCase();
          if (
            options.contentTypes &&
            !options.contentTypes.includes(contentType)
          ) {
            response.body.destroy();
            throw new Error(
              `Web read does not support content type ${contentType || "unknown"}.`,
            );
          }
          const declared = Number(
            response.headers["content-length"] ?? Number.NaN,
          );
          if (Number.isFinite(declared) && declared > compressedLimit) {
            response.body.destroy();
            throw new Error("Web response exceeds the compressed byte limit.");
          }
          const chunks: Buffer[] = [];
          let compressedBytes = 0;
          for await (const chunk of response.body) {
            const bytes = Buffer.from(chunk);
            compressedBytes += bytes.length;
            if (compressedBytes > compressedLimit) {
              response.body.destroy();
              throw new Error(
                "Web response exceeds the compressed byte limit.",
              );
            }
            chunks.push(bytes);
          }
          const body = expandedBody(
            Buffer.concat(chunks, compressedBytes),
            Array.isArray(response.headers["content-encoding"])
              ? response.headers["content-encoding"][0]
              : response.headers["content-encoding"],
            expandedLimit,
          );
          if (body.length > expandedLimit)
            throw new Error("Web response exceeds the expanded byte limit.");
          return {
            body,
            charset:
              rawContentType
                .match(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/iu)?.[1]
                ?.toLowerCase() ?? null,
            contentType,
            headers: response.headers,
            status: response.statusCode,
            url: current.href,
          };
        } finally {
          await dispatcher.close();
        }
      } finally {
        releaseHost();
        if (hostSemaphore.idle) hostRequests.delete(requestHostname);
      }
    }
    throw new Error("Web response exceeded the redirect limit.");
  } finally {
    clearTimeout(timer);
    releaseGlobal();
  }
}

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BROWSER_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    const firstGroup = Number.parseInt(normalized.split(":")[0] || "0", 16);
    return (
      firstGroup < 0x2000 ||
      firstGroup > 0x3fff ||
      normalized.startsWith("2001:db8:")
    );
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part)))
    return false;
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first === 0 ||
    first >= 224
  );
}

export async function validatePublicBrowserUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Only HTTP and HTTPS pages can be opened.");
  if (url.username || url.password)
    throw new Error("URLs containing credentials are not allowed.");
  if (url.hostname === "localhost" || url.hostname.endsWith(".local"))
    throw new Error("Private and local addresses are not proxied.");
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => isPrivateAddress(address))
  )
    throw new Error("Private and local addresses are not proxied.");
  return url;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function injectBrowserBridge(html: string, pageUrl: string): string {
  const bridge = `<base href="${escapeAttribute(pageUrl)}"><script>(function(){
    function send(url){try{var next=new URL(url,document.baseURI);if(next.protocol==='http:'||next.protocol==='https:')parent.postMessage({type:'cantrip-browser-navigate',url:next.href},'*')}catch{}}
    document.addEventListener('click',function(event){var target=event.target;var link=target&&target.closest?target.closest('a[href]'):null;if(!link||link.target==='_blank'||event.defaultPrevented)return;event.preventDefault();send(link.href)},true);
    document.addEventListener('submit',function(event){var form=event.target;if(!form||String(form.method||'get').toLowerCase()!=='get')return;event.preventDefault();var next=new URL(form.action||document.baseURI,document.baseURI);new FormData(form).forEach(function(value,key){if(typeof value==='string')next.searchParams.append(key,value)});send(next.href)},true);
  })();</script>`;
  const head = html.search(/<head(?:\s[^>]*)?>/i);
  if (head >= 0) {
    const end = html.indexOf(">", head);
    if (end >= 0)
      return `${html.slice(0, end + 1)}${bridge}${html.slice(end + 1)}`;
  }
  return `${bridge}${html}`;
}

export interface BrowserProxyResponse {
  body: Buffer;
  contentType: string;
  pageUrl: string;
  status: number;
}

export async function fetchBrowserPage(
  value: string,
): Promise<BrowserProxyResponse> {
  let url = await validatePublicBrowserUrl(value);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(url, {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("The site returned an invalid redirect.");
      url = await validatePublicBrowserUrl(new URL(location, url).toString());
      continue;
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_BROWSER_RESPONSE_BYTES)
      throw new Error("The page is too large to display in Cantrip.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BROWSER_RESPONSE_BYTES)
      throw new Error("The page is too large to display in Cantrip.");
    const contentType =
      response.headers.get("content-type") ?? "application/octet-stream";
    const body = contentType.includes("text/html")
      ? Buffer.from(injectBrowserBridge(bytes.toString("utf8"), url.toString()))
      : bytes;
    return {
      body,
      contentType,
      pageUrl: url.toString(),
      status: response.status,
    };
  }
  throw new Error("The site redirected too many times.");
}

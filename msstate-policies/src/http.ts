/**
 * HTTP wrapper for the msstate-policies scraper.
 *
 *  - Sets a stable, identifying User-Agent so MSU's logs can attribute traffic.
 *  - Concurrency-bounded (4 in flight) to be a polite scraper.
 *  - Retries 429 honoring Retry-After.
 *  - Detects WAF / antibot challenge pages and throws WAFChallengeError so the
 *    caller can avoid caching empty results for 1h.
 */

import { log } from "./log.js";
import { WAFChallengeError } from "./types.js";

const USER_AGENT =
  "msstate-policies-mcp/0.1.0 (+https://github.com/mminsub11/msstate-mcp; node)";

const MAX_CONCURRENT = 4;
const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

let inFlight = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
}

function releaseSlot(): void {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

export interface HttpGetOptions {
  /** Override timeout per request (ms). */
  timeoutMs?: number;
  /** Set to false to skip WAF detection (e.g. when fetching a known PDF). */
  detectWaf?: boolean;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** "text" | "buffer". Defaults to "text". */
  responseType?: "text" | "buffer";
}

export interface HttpResponse {
  status: number;
  url: string;
  body: string | Buffer;
  headers: Headers;
}

/**
 * Detect a WAF / antibot challenge response.
 *
 * The live MSU site is fronted by F5; the `f5_cspm` script is *always* present
 * in normal responses, so we use it as a signal only when the actual data
 * marker (`#datatable` or `<table id="datatable"`) is absent.
 */
export function looksLikeWafChallenge(body: string): boolean {
  if (body.includes("Just a moment...")) return true; // Cloudflare interstitial
  if (body.includes("cf-chl-bypass")) return true;
  if (
    /<meta\s+http-equiv=["']refresh["'][^>]+url=[^>]*token=/i.test(body)
  ) {
    return true;
  }
  // F5 antibot served a bare shell with no data table
  const isAntibotShell =
    /<form[^>]+class=["'][^"']*antibot/i.test(body) &&
    !/id=["']datatable["']/.test(body);
  if (isAntibotShell) return true;
  return false;
}

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfter(header: string | null): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 0;
}

export async function httpGet(
  url: string,
  options: HttpGetOptions = {},
): Promise<HttpResponse> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    detectWaf = true,
    headers = {},
    responseType = "text",
  } = options;

  await acquireSlot();
  try {
    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "GET",
          redirect: "follow",
          signal: controller.signal,
          headers: {
            "User-Agent": USER_AGENT,
            Accept:
              responseType === "buffer"
                ? "application/pdf,*/*;q=0.8"
                : "text/html,application/xhtml+xml,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            ...headers,
          },
        });

        if (res.status === 429 && attempt < MAX_RETRIES) {
          const wait = parseRetryAfter(res.headers.get("retry-after")) || 2000;
          log("warn", "http 429, retrying", { url, attempt, waitMs: wait });
          await delay(wait);
          attempt++;
          continue;
        }

        if (res.status >= 500 && attempt < MAX_RETRIES) {
          const wait = 1000 * Math.pow(2, attempt);
          log("warn", "http 5xx, retrying", { url, status: res.status, attempt, waitMs: wait });
          await delay(wait);
          attempt++;
          continue;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} for ${url}`);
        }

        if (responseType === "buffer") {
          const buf = Buffer.from(await res.arrayBuffer());
          return { status: res.status, url: res.url, body: buf, headers: res.headers };
        }

        const text = await res.text();
        if (detectWaf && looksLikeWafChallenge(text)) {
          throw new WAFChallengeError(url);
        }
        return { status: res.status, url: res.url, body: text, headers: res.headers };
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    releaseSlot();
  }
}

export async function httpPostJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  await acquireSlot();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    releaseSlot();
  }
}

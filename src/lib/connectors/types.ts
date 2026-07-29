import type { Company } from "../companies";

/** Normalized posting shape every connector must return. */
export interface RawPosting {
  externalId: string;
  title: string;
  /** Primary location string, as the board words it. */
  location: string;
  /** Every location this role is open in (boards often list several). */
  locations: string[];
  /** ISO country code when the board gives one (Lever does). */
  countryCode: string | null;
  url: string;
  remote: boolean;
  department: string;
  /** Plain-text description. Used to detect work-authorization blockers. */
  description: string;
  /** When the role was first published — not when it was last edited. */
  postedAt: Date | null;
}

/**
 * Cache validators from the last successful fetch of this board. Sending them
 * back lets the host answer 304 instead of re-serving megabytes of JSON — the
 * cheapest possible way to be a good citizen of someone else's API.
 */
export interface Conditional {
  etag?: string | null;
  lastModified?: string | null;
}

export interface FetchResult {
  postings: RawPosting[];
  etag: string | null;
  lastModified: string | null;
  /** 304: the board is unchanged, so `postings` is empty and means nothing. */
  notModified: boolean;
}

export interface Connector {
  fetch(company: Company, cond?: Conditional): Promise<FetchResult>;
}

/** A non-2xx response, carrying what we need to decide how long to back off. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    /** Parsed from `Retry-After` when the host tells us when to come back. */
    readonly retryAfterSeconds: number | null,
  ) {
    super(`${status} ${statusText}`);
    this.name = "HttpError";
  }

  /** Rate limited, refused, or broken upstream — all mean "wait, don't hammer". */
  get shouldBackOff(): boolean {
    return this.status === 429 || this.status === 403 || this.status >= 500;
  }
}

/** `Retry-After` is either a delay in seconds or an HTTP date. Accept both. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (!isNaN(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  if (isNaN(date)) return null;
  return Math.max(0, Math.round((date - Date.now()) / 1000));
}

/**
 * Identify ourselves honestly. Set JOBSCOUT_CONTACT to a URL or email: an
 * anonymous crawler is the first thing an ops team blocks, a contactable one
 * usually gets an email first.
 */
const contact = process.env.JOBSCOUT_CONTACT?.trim();
const USER_AGENT = `JobScout/1.0 (personal job-search aggregator${
  contact ? `; ${contact}` : ""
})`;

const REMOTE_RE = /remote|anywhere|distributed/i;

/** Best-effort remote detection from a free-text location string. */
export function looksRemote(location: string): boolean {
  return REMOTE_RE.test(location);
}

const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  // Dashes matter more than they look: ATS pay-range markup separates the two
  // ends of a salary band with a bare `&mdash;`, so leaving it encoded turns
  // "$108,400 — $129,600" into something no range parser can read.
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&lsquo;": "'",
  "&rsquo;": "'",
  "&ldquo;": '"',
  "&rdquo;": '"',
  "&bull;": "•",
  "&middot;": "·",
};

function decodeEntities(s: string): string {
  return s
    .replace(
      /&(?:lt|gt|amp|quot|#39|apos|nbsp|mdash|ndash|hellip|lsquo|rsquo|ldquo|rdquo|bull|middot);/g,
      (m) => ENTITIES[m] ?? m,
    )
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

/**
 * Turn an ATS description into searchable plain text. Greenhouse returns HTML
 * that is itself entity-encoded, so entities are decoded, tags stripped, then
 * decoded again to recover the text inside them.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return decodeEntities(decodeEntities(html).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Per-board fetch budget. Generous because description payloads are large —
 * Lever returns megabytes for a board the size of Palantir's — but bounded so a
 * single hanging board can't run a worker past its 60s serverless limit. The
 * slowest board measured takes ~26s, so this leaves real headroom without
 * making the worker's own deadline arithmetic a lie.
 */
export interface JsonResponse {
  /** null when the server answered 304 — nothing was re-sent. */
  data: unknown;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
}

export async function fetchJson(
  url: string,
  cond: Conditional = {},
): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": USER_AGENT,
  };
  if (cond.etag) headers["if-none-match"] = cond.etag;
  if (cond.lastModified) headers["if-modified-since"] = cond.lastModified;

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers,
      cache: "no-store",
    });

    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");

    if (res.status === 304) {
      return { data: null, etag: etag ?? cond.etag ?? null, lastModified, notModified: true };
    }
    if (!res.ok) {
      throw new HttpError(
        res.status,
        res.statusText,
        parseRetryAfter(res.headers.get("retry-after")),
      );
    }
    return { data: await res.json(), etag, lastModified, notModified: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Empty result for a board that answered 304. */
export function unchanged(res: JsonResponse): FetchResult {
  return {
    postings: [],
    etag: res.etag,
    lastModified: res.lastModified,
    notModified: true,
  };
}

import type { RawPosting } from "../connectors";
import { htmlToText } from "../connectors/types";

/**
 * Adzuna's public job search API.
 *
 * This is the sanctioned way to reach the wider market — Adzuna licenses and
 * aggregates listings from job boards (including ones that carry LinkedIn-
 * sourced posts) and publishes them under an API with terms that permit this
 * use. Scraping a site that republishes LinkedIn would inherit LinkedIn's terms
 * *and* break the republisher's, which is why there's no connector for that.
 *
 * Free tier: register at https://developer.adzuna.com for an app id and key,
 * then set ADZUNA_APP_ID and ADZUNA_APP_KEY. Non-commercial use requires
 * attributing Adzuna wherever the results are shown.
 *
 * The one real limitation: search results carry a *truncated* description
 * (~200 characters). Everything downstream that reads the description — the
 * visa blocker phrases in eligibility.ts, the pay band in comp.ts, the
 * experience ask in yoe.ts — will therefore fire much less often on these rows
 * than on ATS ones. Reading the full text would mean fetching the redirect URL,
 * which is the scraping we're avoiding. Location-based eligibility still works,
 * which is the part that matters most here.
 */

interface AdzunaJob {
  id: string;
  title?: string;
  description?: string;
  created?: string;
  redirect_url?: string;
  company?: { display_name?: string };
  location?: { display_name?: string; area?: string[] };
  contract_time?: string;
}

interface AdzunaResponse {
  count?: number;
  results?: AdzunaJob[];
}

export interface AdzunaQuery {
  /** Adzuna country code. "in" is India; the endpoint is per-country. */
  country: string;
  /** Free-text search, e.g. "backend engineer". */
  what: string;
  /** City or region filter. Empty means the whole country. */
  where?: string;
  /** Ignore anything older than this. Freshness is the strongest reply signal. */
  maxDaysOld?: number;
}

const PER_PAGE = 50; // Adzuna's maximum
const MAX_PAGES = 4; // 200 results per query is plenty; be a polite client

export function adzunaConfigured(): boolean {
  return Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
}

function url(q: AdzunaQuery, page: number): string {
  const params = new URLSearchParams({
    app_id: process.env.ADZUNA_APP_ID ?? "",
    app_key: process.env.ADZUNA_APP_KEY ?? "",
    results_per_page: String(PER_PAGE),
    what: q.what,
    "content-type": "application/json",
    sort_by: "date",
  });
  if (q.where) params.set("where", q.where);
  if (q.maxDaysOld) params.set("max_days_old", String(q.maxDaysOld));
  return `https://api.adzuna.com/v1/api/jobs/${q.country}/search/${page}?${params}`;
}

function toPosting(j: AdzunaJob, country: string): RawPosting | null {
  const title = (j.title ?? "").trim();
  const company = (j.company?.display_name ?? "").trim();
  if (!title || !company || !j.id || !j.redirect_url) return null;

  const location = (j.location?.display_name ?? "").trim();
  // `area` is hierarchical, broadest first: ["India", "Karnataka", "Bengaluru"].
  // Passing all of it to the region parser gives it the best shot at a match.
  const areas = (j.location?.area ?? []).filter(Boolean);

  return {
    externalId: String(j.id),
    title: htmlToText(title),
    location,
    locations: [location, ...areas].filter(Boolean),
    countryCode: country.toUpperCase(),
    url: j.redirect_url,
    remote: /remote|work from home|wfh/i.test(`${title} ${location}`),
    department: "",
    // Truncated by the API — see the note at the top of this file.
    description: htmlToText(j.description ?? ""),
    postedAt: j.created ? new Date(j.created) : null,
  };
}

/** The company name Adzuna reports, for deduping against curated boards. */
export function postingCompany(j: AdzunaJob): string {
  return (j.company?.display_name ?? "").trim();
}

/**
 * Run one query to exhaustion (up to MAX_PAGES) and return postings paired with
 * the company Adzuna attributes them to. Pages are fetched in sequence, not in
 * parallel: this is a free tier and a burst of concurrent requests is what gets
 * a key rate-limited.
 */
export async function fetchAdzuna(
  q: AdzunaQuery,
): Promise<{ posting: RawPosting; company: string }[]> {
  if (!adzunaConfigured()) {
    throw new Error(
      "ADZUNA_APP_ID / ADZUNA_APP_KEY are not set. Register at https://developer.adzuna.com",
    );
  }

  const out: { posting: RawPosting; company: string }[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(url(q, page), {
      headers: { "user-agent": "jobscout (personal job search)" },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      // A 410 means we ran past the end of the result set, which is a normal
      // way for a query to finish rather than an error worth surfacing.
      if (res.status === 410) break;
      throw new Error(`adzuna ${q.what}: HTTP ${res.status}`);
    }

    const data = (await res.json()) as AdzunaResponse;
    const results = data.results ?? [];
    if (!results.length) break;

    for (const j of results) {
      const posting = toPosting(j, q.country);
      if (posting) out.push({ posting, company: postingCompany(j) });
    }
    if (results.length < PER_PAGE) break;
  }
  return out;
}

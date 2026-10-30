/**
 * LinkedIn's public guest endpoints, shared by apply-mcp and the watcher.
 *
 * These are the endpoints LinkedIn's own logged-out job pages load from: plain
 * HTML fragments, no session, no browser. Ten results per search page.
 */
import { scoreJob } from "@/lib/scoring";
import type { Company } from "@/lib/companies";

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<br\s*\/?>|<\/(p|div|h\d|ul|ol|li)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export function pick(html: string, cls: string): string | null {
  const m = html.match(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</`));
  return m ? htmlToText(m[1]).replace(/\s+/g, " ").trim() || null : null;
}

export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

export async function getText(url: string, tries = 3): Promise<string> {
  for (let a = 0; ; a++) {
    const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en-US,en" } });
    if (r.ok) return r.text();
    if (a + 1 >= tries || (r.status !== 429 && r.status < 500)) {
      throw new Error(`${r.status} from ${new URL(url).pathname}`);
    }
    await sleep(800 * (a + 1));
  }
}

export const EXPERIENCE = { internship: 1, entry: 2, associate: 3, "mid-senior": 4, director: 5, executive: 6 } as const;
export const WORKPLACE = { onsite: 1, remote: 2, hybrid: 3 } as const;

export interface Card {
  jobId: string;
  title: string;
  company: string;
  location: string;
  posted: string | null;
}

export function parseCards(html: string): Card[] {
  return html
    .split(/<li>/)
    .slice(1)
    .map((c) => {
      const id = c.match(/jobPosting:(\d+)/)?.[1];
      if (!id) return null;
      return {
        jobId: id,
        title: pick(c, "base-search-card__title") ?? "",
        company: pick(c, "base-search-card__subtitle") ?? "",
        location: pick(c, "job-search-card__location") ?? "",
        posted: c.match(/datetime="([^"]+)"/)?.[1] ?? null,
      };
    })
    .filter((c): c is Card => !!c);
}

export interface GuestDetail {
  title: string;
  company: string;
  location: string;
  postedAgo: string | null;
  applicants: string | null;
  criteria: Record<string, string>;
  description: string;
}

export async function guestDetail(jobId: string): Promise<GuestDetail> {
  const h = await getText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`);
  const criteria: Record<string, string> = {};
  for (const m of h.matchAll(
    /description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>[\s\S]*?description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/g,
  )) {
    criteria[htmlToText(m[1])] = htmlToText(m[2]);
  }
  const desc = h.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
  return {
    title: pick(h, "top-card-layout__title") ?? "",
    company: pick(h, "topcard__org-name-link") ?? pick(h, "topcard__flavor") ?? "",
    location: pick(h, "topcard__flavor--bullet") ?? "",
    postedAgo: pick(h, "posted-time-ago__text"),
    applicants: pick(h, "num-applicants__caption"),
    criteria,
    description: htmlToText(desc),
  };
}

export const LINKEDIN_COMPANY: Company = {
  name: "LinkedIn result",
  ats: "greenhouse",
  token: "",
  hiresIn: ["india"],
  tags: [],
};

export function score(title: string, location: string, description: string) {
  return scoreJob(
    {
      title,
      description,
      location,
      locations: [location],
      countryCode: /india/i.test(location) ? "IN" : null,
    },
    LINKEDIN_COMPANY,
  );
}

export interface SearchOptions {
  keywords: string;
  location?: string;
  experience?: (keyof typeof EXPERIENCE)[];
  workplace?: (keyof typeof WORKPLACE)[];
  /** Window in seconds. LinkedIn takes any value, not just its UI's presets. */
  postedWithinSeconds: number;
  pages?: number;
  /** "DD" newest first, "R" relevance. */
  sort?: "DD" | "R";
}

/** One search, pages fetched in parallel, de-duplicated by jobId. */
export async function searchLinkedIn(o: SearchOptions): Promise<Card[]> {
  const base = new URL("https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search");
  base.searchParams.set("keywords", o.keywords);
  base.searchParams.set("location", o.location ?? "India");
  base.searchParams.set("f_TPR", `r${o.postedWithinSeconds}`);
  if (o.sort) base.searchParams.set("sortBy", o.sort);
  if (o.experience?.length) base.searchParams.set("f_E", o.experience.map((e) => EXPERIENCE[e]).join(","));
  if (o.workplace?.length) base.searchParams.set("f_WT", o.workplace.map((w) => WORKPLACE[w]).join(","));
  const pages = await Promise.all(
    Array.from({ length: o.pages ?? 1 }, (_, i) => {
      const u = new URL(base);
      u.searchParams.set("start", String(i * 10));
      return getText(u.href).then(parseCards, () => [] as Card[]);
    }),
  );
  const seen = new Set<string>();
  return pages.flat().filter((c) => !seen.has(c.jobId) && seen.add(c.jobId));
}

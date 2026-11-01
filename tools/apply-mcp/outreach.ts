/**
 * Cold outreach: which companies to write to, who to write to there, and a
 * local outbox so nobody gets the same email twice.
 *
 * Three pieces, each cheap on its own:
 *
 *   - companiesFit ranks companies, not jobs. A job list answers "what can I
 *     apply to today"; a cold email is worth sending to a company that keeps
 *     hiring your stack, whether or not today's req fits. Board data comes from
 *     the jobs table, discovery outside the board from LinkedIn's guest search.
 *   - findContacts collects addresses that are already public: the company's
 *     own careers, contact and team pages, its GitHub org, and web search hits
 *     on "@domain". Nothing is guessed. A contact without a public address is
 *     returned as a name and profile to message instead.
 *   - The outbox (~/.jobscout/outreach/outbox.json) holds every draft and what
 *     happened to it. Gmail does the sending; see gmailCompose in server.ts.
 *
 * Browser work (LinkedIn people search, Gmail) lives in server.ts, which owns
 * the Chrome connection. This file only does HTTP and bookkeeping.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { profile } from "@/lib/profile";
import { isEngineeringRole } from "@/lib/scoring";
import { locationVerdict } from "@/lib/location-pref";
import { UA, decodeEntities, pool, score, searchLinkedIn } from "../lib/linkedin";

const DIR = join(homedir(), ".jobscout", "outreach");
const OUTBOX = join(DIR, "outbox.json");

// ---------------------------------------------------------------------------
// Company fit

export interface CompanyFit {
  company: string;
  fit: number;
  /** "open role" when something on the board fits you now, "growing" when they hire your stack above or around your level. */
  kind: "open role" | "growing" | "discovered";
  engRoles: number;
  atLevel: number;
  /** Engineering roles first seen in the window vs the window before it. */
  recent: number;
  prior: number;
  stack: string[];
  cities: string[];
  sample: string[];
  source: "board" | "linkedin";
}

const termRe = (t: string) => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
const TECH = profile.techKeywords.map((t) => ({ t, re: termRe(t) }));
/** "golang" and "go", "node.js" and "nodejs" are one skill on a résumé. */
const canon = (t: string) =>
  t.replace(/^golang$/, "go").replace(/^(nodejs|node\.js)$/, "node").replace(/^(reactjs|react\.js)$/, "react")
    .replace(/^nextjs$/, "next.js").replace(/^postgresql$/, "postgres");
const stackOf = (s: string) => [...new Set(TECH.filter((x) => x.re.test(s)).map((x) => canon(x.t)))];

const DAY = 86400_000;
/** Titles that ask for more than ~3 years whatever the JD's number says. */
const SENIOR = /\b(senior|sr\.?|lead|staff|principal|architect|manager|director|head of|vp)\b/i;

/**
 * Board companies, scored on four things that predict a reply to a cold email:
 * stack overlap, roles at your level in places you'd go, hiring momentum, and
 * volume. Companies you've already applied to are left out.
 */
export async function boardFit(days: number): Promise<CompanyFit[]> {
  if (!db) throw new Error("DATABASE_URL is not set, so the board can't be read. Add it to .env.");
  const rows = (await db.execute(sql`
    select company, title, location, yoe_min, score, eligibility,
           coalesce(posted_at, first_seen_at) as seen,
           left(description, 4000) as description
    from jobs
    where coalesce(posted_at, first_seen_at) > now() - make_interval(days => ${days * 2})
  `)).rows as { company: string; title: string; location: string; yoe_min: number | null; score: number; eligibility: string; seen: string; description: string }[];
  const applied = new Set(
    ((await db.execute(sql`select distinct lower(company) as c from applications where status <> 'saved'`)).rows as { c: string }[]).map((r) => r.c),
  );

  const now = Date.now();
  const by = new Map<string, typeof rows>();
  for (const r of rows) {
    if (applied.has(r.company.toLowerCase()) || !isEngineeringRole(r.title)) continue;
    by.set(r.company, [...(by.get(r.company) ?? []), r]);
  }

  const out: CompanyFit[] = [];
  for (const [company, list] of by) {
    const recent = list.filter((r) => now - +new Date(r.seen) < days * DAY).length;
    const prior = list.length - recent;
    const stackCount = new Map<string, number>();
    for (const r of list) for (const t of stackOf(`${r.title} ${r.description}`)) stackCount.set(t, (stackCount.get(t) ?? 0) + 1);
    const stack = [...stackCount.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
    // "eligible" already means hireable from India (see lib/eligibility.ts); the
    // location check then narrows that to the cities you'd actually go to.
    const fitsHere = (r: (typeof list)[number]) => r.eligibility === "eligible" && locationVerdict(r.location, "").ok;
    const atLevel = list.filter(
      (r) => fitsHere(r) && (r.yoe_min == null || r.yoe_min <= profile.yearsExperience + 1) && !SENIOR.test(r.title),
    );
    const cities = [...new Set(list.filter(fitsHere).map((r) => r.location.split(/[,;|]/)[0].trim()).filter(Boolean))].slice(0, 3);
    if (!stack.length || !list.some(fitsHere)) continue;

    // Weights are deliberately coarse: this ranks a shortlist to read, not a decision.
    const fit = Math.round(
      Math.min(stack.length, 6) * 7 +
        Math.min(atLevel.length, 4) * 8 +
        (recent > prior ? 8 : 0) +
        Math.min(Math.log2(list.length + 1) * 4, 16),
    );
    out.push({
      company,
      fit,
      kind: atLevel.length ? "open role" : "growing",
      engRoles: list.length,
      atLevel: atLevel.length,
      recent,
      prior,
      stack: stack.slice(0, 6),
      cities,
      sample: (atLevel.length ? atLevel : list).sort((a, b) => b.score - a.score).slice(0, 2).map((r) => r.title),
      source: "board",
    });
  }
  return out;
}

/**
 * Companies outside the curated board: LinkedIn's guest job search across your
 * role phrases and cities. Titles and locations only, no detail fetch, so a run
 * is ~one request per role and city.
 */
export async function discoverFit(roles: string[], days: number, known: Set<string>): Promise<CompanyFit[]> {
  const places = [...new Set(profile.locations.cities.filter((c) => !["bengaluru", "navi mumbai", "thane"].includes(c)))];
  const queries = roles.flatMap((r) => places.map((loc) => ({ r, loc })));
  const cards = (await pool(queries, 6, ({ r, loc }) =>
    searchLinkedIn({ keywords: r, location: `${loc}, India`, postedWithinSeconds: days * 86400, pages: 2 }).catch(() => []),
  )).flat();
  const by = new Map<string, typeof cards>();
  for (const c of cards) {
    if (!c.company || known.has(c.company.toLowerCase()) || !isEngineeringRole(c.title)) continue;
    if (profile.repostBlocklist.some((n) => c.company.toLowerCase().includes(n))) continue;
    by.set(c.company, [...(by.get(c.company) ?? []), c]);
  }
  return [...by.entries()].map(([company, list]) => {
    const scored = list.map((c) => ({ c, s: score(c.title, c.location, "") }));
    const ok = scored.filter((x) => x.s.eligibility !== "blocked" && !SENIOR.test(x.c.title));
    const stack = stackOf(list.map((c) => c.title).join(" "));
    const fit = Math.round(Math.min(ok.length, 4) * 8 + stack.length * 7 + Math.max(...scored.map((x) => x.s.score), 0) / 5);
    return {
      company,
      fit,
      kind: "discovered" as const,
      engRoles: list.length,
      atLevel: ok.length,
      recent: list.length,
      prior: 0,
      stack,
      cities: [...new Set(list.map((c) => c.location.split(",")[0]))].slice(0, 3),
      sample: list.slice(0, 2).map((c) => c.title),
      source: "linkedin" as const,
    };
  });
}

export function formatFit(f: CompanyFit, n: number, days: number): string {
  const trend = f.source === "board" ? ` | ${f.recent} new in ${days}d vs ${f.prior} before` : "";
  return `#${n} ${f.fit} | ${f.company} | ${f.kind} | ${f.engRoles} eng roles, ${f.atLevel} at your level${trend} | stack: ${f.stack.join(", ") || "?"} | ${f.cities.join(", ")}\n   e.g. ${f.sample.join("; ")}`;
}

// ---------------------------------------------------------------------------
// Web search

export interface WebHit {
  title: string;
  url: string;
  snippet: string;
}

/** Runs one web search. server.ts supplies Google in the real browser; bingSearch is the no-browser fallback. */
export type Searcher = (q: string, n?: number) => Promise<WebHit[]>;

/**
 * Bing's HTML results over plain HTTP. Usable but noticeably worse than a real
 * browser's: Bing serves scripted clients a degraded index, and DuckDuckGo's
 * HTML endpoint answers them with a bot check. Fallback only.
 */
export const bingSearch: Searcher = async (q, n = 10) => {
  const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en&count=${n}`, {
    headers: { "user-agent": UA, "accept-language": "en-US,en" },
  });
  if (!r.ok) throw new Error(`search ${r.status}`);
  const strip = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
  return (await r.text())
    .split('<li class="b_algo"')
    .slice(1)
    .map((b) => {
      const a = b.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) return null;
      let url = decodeEntities(a[1]);
      // Bing wraps results in a click tracker: u=a1<base64url of the target>.
      const enc = url.match(/[?&]u=a1([^&]+)/)?.[1];
      if (enc) url = Buffer.from(enc.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
      return { title: strip(a[2]), url, snippet: strip(b.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "") };
    })
    .filter((x): x is WebHit => !!x)
    .slice(0, n);
};

// ---------------------------------------------------------------------------
// Contacts

export interface Contact {
  email: string | null;
  name: string | null;
  role: string;
  kind: "hiring inbox" | "person" | "general" | "linkedin";
  source: string;
}

const EMAIL = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
/** Addresses that exist to say no: legal, privacy, abuse, automated mail. */
const JUNK = /^(no-?reply|donotreply|privacy|legal|abuse|security|dpo|gdpr|compliance|unsubscribe|bounce|mailer-daemon|postmaster|webmaster|billing|invoices?|accounts|press|media|investors?|ir|sales|support|help|events?|marketing|partners?|partnerships|feedback|orders?|returns|pr|developers?|devrel|api|community|ethics|whistleblow\w*)([._-][\w.-]*)?@/i;
const HIRING = /^(careers?|jobs?|hr|hiring|talent|recruit(ing|ment|er)?|people|join|work|resume|cv|ta)[._-]?\w*@/i;
const GENERAL = /^(info|contact|hello|hi|team|admin|office|enquir(y|ies)|inquir(y|ies))@/i;
const NOT_COMPANY = /linkedin|wikipedia|glassdoor|crunchbase|naukri|ambitionbox|indeed|zaubacorp|tofler|facebook|instagram|twitter|x\.com|youtube|justdial|wellfound|instahyre|cutshort|tracxn|bloomberg|zoominfo|rocketreach|apollo\.io|signalhire|contactout/i;

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** The company's own domain, from the first search hit that isn't a directory or social site. */
export async function resolveDomain(company: string, search: Searcher): Promise<string | null> {
  const hits = await search(`${company} official website`, 8).catch(() => []);
  // The domain has to carry the name: "Celigo" -> celigo.com, never a directory that ranked first.
  const words = company.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !/^(inc|ltd|llp|pvt|private|limited|technologies|technology|solutions|systems|labs|software|corp|corporation|group|the)$/.test(w));
  return hits.map((h) => host(h.url)).find((d) => d && !NOT_COMPANY.test(d) && words.some((w) => d.replace(/[^a-z0-9.]/g, "").includes(w))) ?? null;
}

/** Cloudflare's email obfuscation: hex string XORed with its first byte. */
function cfDecode(hex: string): string {
  const k = parseInt(hex.slice(0, 2), 16);
  let s = "";
  for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k);
  return s;
}

function emailsIn(html: string): string[] {
  const cf = [...html.matchAll(/data-cfemail="([0-9a-f]+)"/gi)].map((m) => cfDecode(m[1]));
  // JSON-escaped markup ("\u003emedia@...") leaves the escape glued to the address.
  const plain = decodeEntities(html.replace(/\\?u00[0-9a-f]{2}/gi, " ").replace(/%40|\[at\]|\(at\)/gi, "@")).match(EMAIL) ?? [];
  return [...new Set([...cf, ...plain].map((e) => e.toLowerCase().replace(/\.+$/, "")))].filter(
    (e) => !/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(e) && !/@(example|sentry|wixpress|domain)\./.test(e),
  );
}

async function get(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en-US,en" }, redirect: "follow", signal: AbortSignal.timeout(10000) });
  if (!r.ok) return "";
  if (!/text|html|json/.test(r.headers.get("content-type") ?? "")) return "";
  return (await r.text()).slice(0, 600_000);
}

const PATHS = ["", "/careers", "/jobs", "/contact", "/contact-us", "/about", "/about-us", "/team", "/company", "/join-us", "/.well-known/security.txt"];

function classify(email: string, domain: string): Contact["kind"] | null {
  if (JUNK.test(email)) return null;
  if (!email.endsWith(`@${domain}`) && !email.endsWith(`.${domain}`)) return null;
  if (HIRING.test(email)) return "hiring inbox";
  if (GENERAL.test(email)) return "general";
  // first, first.last, first_last, flast: anything else is a team alias.
  return /^[a-z]{2,}([._][a-z]{2,})?@/.test(email) ? "person" : "general";
}

/**
 * Public addresses at the company's domain, each with the page it came from.
 * Order: the company's own pages, its GitHub org, then the open web.
 */
export async function webContacts(domain: string, company: string, search: Searcher): Promise<{ contacts: Contact[]; checked: string[] }> {
  const found = new Map<string, Contact>();
  const add = (email: string, source: string, role = "") => {
    const kind = classify(email, domain);
    if (!kind || found.has(email)) return;
    found.set(email, { email, name: null, role, kind, source });
  };
  const checked: string[] = [];

  // 1. The site. The homepage also tells us where its careers/team pages really are.
  const home = await get(`https://${domain}`).catch(() => "");
  const linked = [...home.matchAll(/href="([^"#]+)"/g)]
    .map((m) => {
      try {
        return new URL(m[1], `https://${domain}`).href;
      } catch {
        return "";
      }
    })
    .filter((u) => host(u).endsWith(domain) && /career|job|join|team|contact|about|people|hiring/i.test(u));
  const pages = [...new Set([...PATHS.map((p) => `https://${domain}${p}`), ...linked])].slice(0, 14);
  const bodies = await pool(pages, 5, (u) => get(u).catch(() => ""));
  pages.forEach((u, i) => {
    if (!bodies[i]) return;
    checked.push(u);
    for (const e of emailsIn(bodies[i])) add(e, u);
  });
  for (const e of emailsIn(home)) add(e, `https://${domain}`);

  // 2. GitHub org profile, which engineering teams often fill in.
  const slug = domain.split(".")[0];
  const gh = await fetch(`https://api.github.com/orgs/${slug}`, { headers: { "user-agent": UA, accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null) as { email?: string; blog?: string; html_url?: string } | null;
  if (gh?.email && (!gh.blog || host(gh.blog).endsWith(domain))) add(gh.email.toLowerCase(), gh.html_url ?? "github");

  // 3. The open web: anywhere "@domain" is printed next to hiring words.
  for (const q of [`"@${domain}" careers OR hiring OR recruiter OR "talent acquisition"`, `"@${domain}" ${company} engineering manager OR CTO OR founder`]) {
    for (const h of await search(q, 10).catch(() => [])) {
      for (const e of emailsIn(`${h.title} ${h.snippet}`)) add(e, h.url, h.title.slice(0, 60));
    }
  }

  const rank = { "hiring inbox": 0, person: 1, general: 2, linkedin: 3 };
  return { contacts: [...found.values()].sort((a, b) => rank[a.kind] - rank[b.kind]), checked };
}

// ---------------------------------------------------------------------------
// Outbox

export interface Draft {
  id: string;
  /** Missing on entries written before LinkedIn messages existed: those are email. */
  channel?: "email" | "linkedin";
  company: string;
  domain: string;
  to: string;
  toName: string | null;
  subject: string;
  body: string;
  resume: string | null;
  /** draft: written here only. composed: open in Gmail as a draft. sent: you sent it (or email_send did). */
  status: "draft" | "composed" | "sent" | "skipped";
  createdAt: string;
  composedAt?: string;
  sentAt?: string;
  source?: string;
}

export function loadOutbox(): Draft[] {
  try {
    return JSON.parse(readFileSync(OUTBOX, "utf8"));
  } catch {
    return [];
  }
}

export function saveOutbox(d: Draft[]): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(OUTBOX, JSON.stringify(d, null, 2));
}

/** Days a company or address is left alone after an email. Two cold emails in a month reads as spam. */
const COOLDOWN_DAYS = 45;
/** Gmail flags new accounts sending many near-identical emails; this stays well under that. */
export const DAILY_CAP = 15;

/** Reasons not to send this one, empty when it's fine. */
export function outboxCheck(to: string, domain: string, body: string, all: Draft[]): string[] {
  const warn: string[] = [];
  const since = Date.now() - COOLDOWN_DAYS * DAY;
  // Email: one per company per cooldown. LinkedIn: one per person, since a
  // recruiter and an engineering manager at the same company are separate asks.
  const prev = all.find(
    (d) =>
      d.status !== "skipped" && d.status !== "draft" && +new Date(d.composedAt ?? d.createdAt) > since &&
      (d.to === to || ((d.channel ?? "email") === "email" && to.includes("@") && d.domain === domain)),
  );
  if (prev) warn.push(`already emailed ${prev.to} at ${prev.company} on ${(prev.sentAt ?? prev.composedAt ?? prev.createdAt).slice(0, 10)}`);
  const today = all.filter((d) => (d.composedAt ?? "").slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
  if (today >= DAILY_CAP) warn.push(`${today} emails composed today, cap is ${DAILY_CAP}`);
  const words = body.trim().split(/\s+/).length;
  if (words > 220) warn.push(`${words} words; cold emails over ~200 rarely get read`);
  if (/\{\{|\[(name|company|role)\]/i.test(body)) warn.push("unfilled placeholder in body");
  return warn;
}

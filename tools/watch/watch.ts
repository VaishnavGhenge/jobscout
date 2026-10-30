/**
 * New-posting watcher: run every 10 minutes by launchd (see install.sh).
 *
 * Being early is the point: a good role collects dozens of applicants in its
 * first hour, so this polls the sources that carry exact posting times and
 * pushes an alert for anything that clears the fit threshold.
 *
 * It is built to stay off the database. Every ATS board is polled with its
 * ETag, so an unchanged board is a 304, and new postings are found by diffing
 * job ids against a local state file. Neon is only woken (refreshCompany) for
 * a company that actually posted something, which keeps a 10-minute loop
 * inside the free tier.
 *
 *   node --env-file=.env tools/watch/dist/watch.mjs            one tick
 *   node --env-file=.env tools/watch/dist/watch.mjs --dry      no alerts, no DB
 *   node --env-file=.env tools/watch/dist/watch.mjs --test     send a test alert
 */
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { companies, type Company } from "@/lib/companies";
import { connectors } from "@/lib/connectors";
import { refreshCompany } from "@/lib/refresh";
import { isEngineeringRole, scoreJob } from "@/lib/scoring";
import { guestDetail, pool, score as scoreLinkedIn, searchLinkedIn, type SearchOptions } from "../lib/linkedin";
import searches from "./searches.json";

const DIR = join(homedir(), ".jobscout");
const CONFIG = join(DIR, "watch.json");
const STATE = join(DIR, "watch-state.json");
const ALERTS = join(DIR, "alerts.jsonl");

/** Rippling has no ETags and costs a request per posting, so it ticks hourly. */
const MIN_INTERVAL_MIN: Partial<Record<Company["ats"], number>> = { rippling: 60 };
/** A "new" id on a board can be an old role reposted or a newly added company. */
const DEFAULT_MAX_AGE_H = 48;
/** Same role seen on LinkedIn and on its ATS board alerts once. */
const DEDUPE_DAYS = 3;

interface Config {
  ntfyTopic?: string;
  threshold: number;
  maxAgeHours: number;
}

interface State {
  ats: Record<string, { etag: string | null; lastModified: string | null; ids: string[]; polledAt: number }>;
  linkedin: Record<string, number>;
  alerted: Record<string, number>;
}

interface Hit {
  source: string;
  company: string;
  title: string;
  location: string;
  url: string;
  score: number;
  reasons: string[];
  postedAt: Date | null;
  extra?: string;
}

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");

function load<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function ago(d: Date | null): string {
  if (!d) return "posted ?";
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  return m < 90 ? `posted ${m} min ago` : m < 48 * 60 ? `posted ${Math.round(m / 60)} h ago` : `posted ${Math.round(m / 1440)} d ago`;
}

/** "21 minutes ago" -> a Date. LinkedIn's guest cards only carry the day. */
function parseAgo(s: string | null): Date | null {
  const m = s?.match(/(\d+)\s*(minute|hour|day|week)/);
  if (!m) return null;
  const unit = { minute: 1, hour: 60, day: 1440, week: 10080 }[m[2] as "minute"];
  return new Date(Date.now() - Number(m[1]) * unit * 60000);
}

// ---------------------------------------------------------------------------
// Alerts

function macNotify(title: string, body: string): Promise<void> {
  const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return new Promise((r) =>
    execFile("osascript", ["-e", `display notification "${q(body)}" with title "${q(title)}" sound name "Glass"`], () => r()),
  );
}

async function phoneNotify(topic: string, h: { title: string; body: string; url: string; score: number }): Promise<void> {
  await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topic,
      title: h.title,
      message: h.body,
      click: h.url,
      priority: h.score >= 85 ? 5 : 4,
      tags: ["briefcase"],
    }),
  }).catch((e) => console.error(`ntfy failed: ${(e as Error).message}`));
}

async function alert(cfg: Config, h: Hit): Promise<void> {
  const title = `${h.score} · ${h.title} · ${h.company}`;
  const body = [ago(h.postedAt), h.location, h.extra, h.reasons.slice(0, 2).join("; ")].filter(Boolean).join(" · ");
  console.log(`ALERT ${title} | ${body} | ${h.url}`);
  if (DRY) return;
  if (h.source !== "test") appendFileSync(
    ALERTS,
    JSON.stringify({
      at: new Date().toISOString(),
      source: h.source,
      company: h.company,
      title: h.title,
      url: h.url,
      score: h.score,
      postedAt: h.postedAt?.toISOString() ?? null,
      lagMin: h.postedAt ? Math.round((Date.now() - h.postedAt.getTime()) / 60000) : null,
    }) + "\n",
  );
  await Promise.all([
    macNotify(title, body),
    cfg.ntfyTopic ? phoneNotify(cfg.ntfyTopic, { title, body, url: h.url, score: h.score }) : Promise.resolve(),
  ]);
}

// ---------------------------------------------------------------------------
// Sources

async function pollAts(state: State, cfg: Config): Promise<{ hits: Hit[]; changed: Company[]; polled: number; errors: string[] }> {
  const hits: Hit[] = [];
  const changed: Company[] = [];
  const errors: string[] = [];
  const due = companies.filter((c) => {
    const prev = state.ats[c.name];
    const every = MIN_INTERVAL_MIN[c.ats] ?? 0;
    return !prev || Date.now() - prev.polledAt >= every * 60000 - 30000;
  });
  await pool(due, 6, async (c) => {
    const prev = state.ats[c.name];
    try {
      const r = await connectors[c.ats].fetch(c, prev ? { etag: prev.etag, lastModified: prev.lastModified } : undefined);
      if (r.notModified) {
        prev!.polledAt = Date.now();
        return;
      }
      const ids = r.postings.map((p) => p.externalId);
      const known = new Set(prev?.ids ?? []);
      state.ats[c.name] = { etag: r.etag, lastModified: r.lastModified, ids, polledAt: Date.now() };
      if (!prev) return; // first sight of this board: seed, don't alert on its backlog
      const fresh = r.postings.filter((p) => !known.has(p.externalId));
      if (!fresh.length) return;
      changed.push(c);
      for (const p of fresh) {
        if (!isEngineeringRole(p.title)) continue;
        if (p.postedAt && Date.now() - p.postedAt.getTime() > cfg.maxAgeHours * 3600000) continue;
        const s = scoreJob(p, c);
        if (s.eligibility === "blocked" || s.score < cfg.threshold) continue;
        hits.push({
          source: c.ats,
          company: c.name,
          title: p.title,
          location: p.location,
          url: p.url,
          score: s.score,
          reasons: s.reasons,
          postedAt: p.postedAt,
        });
      }
    } catch (e) {
      errors.push(`${c.name}: ${(e as Error).message.slice(0, 80)}`);
    }
  });
  return { hits, changed, polled: due.length, errors };
}

async function pollLinkedIn(state: State, cfg: Config): Promise<{ hits: Hit[]; seen: number; fresh: number }> {
  const cards = (await Promise.all((searches as SearchOptions[]).map((s) => searchLinkedIn(s).catch(() => [])))).flat();
  const fresh = cards.filter((c) => !state.linkedin[c.jobId]);
  for (const c of cards) state.linkedin[c.jobId] ??= Date.now();
  const eng = [...new Map(fresh.map((c) => [c.jobId, c])).values()].filter((c) => isEngineeringRole(c.title));
  const details = await pool(eng, 5, (c) => guestDetail(c.jobId).catch(() => null));
  const hits: Hit[] = [];
  eng.forEach((c, i) => {
    const d = details[i];
    const s = scoreLinkedIn(c.title, c.location, d?.description ?? "");
    if (s.eligibility === "blocked" || s.score < cfg.threshold) return;
    hits.push({
      source: "linkedin",
      company: c.company,
      title: c.title,
      location: c.location,
      url: `https://www.linkedin.com/jobs/view/${c.jobId}/`,
      score: s.score,
      reasons: s.reasons,
      postedAt: parseAgo(d?.postedAgo ?? null) ?? (c.posted ? new Date(c.posted) : null),
      extra: d?.applicants ?? undefined,
    });
  });
  return { hits, seen: cards.length, fresh: fresh.length };
}

// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(DIR, { recursive: true });
  const cfg: Config = { threshold: 70, maxAgeHours: DEFAULT_MAX_AGE_H, ...load<Partial<Config>>(CONFIG, {}) };

  if (args.has("--test")) {
    await alert(cfg, {
      source: "test",
      company: "jobscout",
      title: "Test alert",
      location: "Pune",
      url: "https://www.linkedin.com/jobs/",
      score: 99,
      reasons: ["watcher is wired up"],
      postedAt: new Date(),
    });
    return;
  }

  const state = load<State>(STATE, { ats: {}, linkedin: {}, alerted: {} });
  const t0 = Date.now();
  const [ats, li] = await Promise.all([pollAts(state, cfg), pollLinkedIn(state, cfg)]);

  const now = Date.now();
  for (const [k, v] of Object.entries(state.alerted)) if (now - v > DEDUPE_DAYS * 86400000) delete state.alerted[k];
  for (const [k, v] of Object.entries(state.linkedin)) if (now - v > 14 * 86400000) delete state.linkedin[k];

  const hits = [...ats.hits, ...li.hits].sort((a, b) => b.score - a.score);
  let sent = 0;
  for (const h of hits) {
    const key = `${norm(h.company)}|${norm(h.title)}`;
    if (state.alerted[key]) continue;
    state.alerted[key] = now;
    await alert(cfg, h);
    sent++;
  }
  // Save before the DB step: a slow or failing Neon must not cost us the diff.
  writeFileSync(STATE, JSON.stringify(state));

  let db = "";
  if (!DRY && ats.changed.length && process.env.DATABASE_URL) {
    const res = await pool(ats.changed, 3, (c) => refreshCompany(c).then(() => null, (e: Error) => `${c.name}: ${e.message.slice(0, 60)}`));
    const failed = res.filter(Boolean);
    db = ` db=${ats.changed.length - failed.length}/${ats.changed.length}${failed.length ? ` (${failed.join("; ")})` : ""}`;
  }

  console.log(
    `${new Date().toISOString()} ats=${ats.polled} changed=${ats.changed.length} li=${li.seen}/${li.fresh}new alerts=${sent}${db} ${Date.now() - t0}ms` +
      (ats.errors.length ? ` errors: ${ats.errors.slice(0, 3).join(" / ")}` : ""),
  );
}

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
await main();

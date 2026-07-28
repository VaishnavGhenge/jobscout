import type { Region } from "./regions";

export type Ats =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "rippling";

export interface Company {
  name: string;
  ats: Ats;
  token: string; // board token / slug used by the ATS API
  /**
   * Regions this company demonstrably employs people in. Used as the fallback
   * when a posting's own location is vague ("Global", "Remote") — a borderless
   * listing from a company with no presence where you live is a long shot, not
   * an opportunity.
   *
   * Seeded on 2026-07-28 by counting the regions in each board's live postings.
   * Re-check it when a company opens or closes an office: `GET /api/audit`
   * prints the current counts and flags any company whose board contradicts
   * what's declared here.
   */
  hiresIn: Region[];
  tags: string[]; // for your own filtering context
}

/**
 * Curated target list. Every token below was verified live against its ATS API.
 * Add more by finding a company's board:
 *   greenhouse      -> boards-api.greenhouse.io/v1/boards/<token>/jobs
 *   lever           -> api.lever.co/v0/postings/<token>?mode=json
 *   ashby           -> api.ashbyhq.com/posting-api/job-board/<token>
 *   smartrecruiters -> api.smartrecruiters.com/v1/companies/<token>/postings
 *   rippling        -> api.rippling.com/platform/api/ats/v1/board/<token>/jobs
 *
 * SmartRecruiters answers 200 with `totalFound: 0` for a token that doesn't
 * exist, so check the count rather than the status code when adding one.
 */
export const companies: Company[] = [
  // India-first — highest realistic response rate if you're based there.
  { name: "Razorpay", ats: "greenhouse", token: "razorpaysoftwareprivatelimited", hiresIn: ["india"], tags: ["fintech", "india"] },
  { name: "Groww", ats: "greenhouse", token: "groww", hiresIn: ["india"], tags: ["fintech", "india"] },
  { name: "CRED", ats: "lever", token: "cred", hiresIn: ["india"], tags: ["fintech", "india"] },
  { name: "Postman", ats: "greenhouse", token: "postman", hiresIn: ["india", "us", "eu"], tags: ["devtools", "india"] },
  { name: "Freshworks", ats: "smartrecruiters", token: "Freshworks", hiresIn: ["india", "us", "uk", "eu"], tags: ["saas", "india"] },

  // Fintech
  { name: "Stripe", ats: "greenhouse", token: "stripe", hiresIn: ["india", "us", "canada", "uk", "eu", "apac"], tags: ["fintech"] },
  { name: "Coinbase", ats: "greenhouse", token: "coinbase", hiresIn: ["india", "us", "canada", "uk", "eu"], tags: ["fintech", "crypto"] },
  { name: "Robinhood", ats: "greenhouse", token: "robinhood", hiresIn: ["us", "canada", "uk"], tags: ["fintech"] },
  { name: "Ramp", ats: "ashby", token: "ramp", hiresIn: ["us", "canada", "uk"], tags: ["fintech"] },
  { name: "Wise", ats: "smartrecruiters", token: "Wise", hiresIn: ["india", "uk", "eu", "apac", "us"], tags: ["fintech"] },

  // Devtools / infra (your sweet spot)
  { name: "GitLab", ats: "greenhouse", token: "gitlab", hiresIn: ["india", "us", "canada", "uk", "eu", "apac"], tags: ["devtools", "remote"] },
  { name: "Cloudflare", ats: "greenhouse", token: "cloudflare", hiresIn: ["india", "us", "uk", "eu", "apac"], tags: ["infra"] },
  { name: "Vercel", ats: "greenhouse", token: "vercel", hiresIn: ["india", "us", "uk", "eu"], tags: ["devtools"] },
  { name: "MongoDB", ats: "greenhouse", token: "mongodb", hiresIn: ["india", "us", "canada", "uk", "eu", "apac"], tags: ["database"] },
  { name: "Elastic", ats: "greenhouse", token: "elastic", hiresIn: ["india", "us", "eu", "uk", "apac"], tags: ["infra", "search"] },
  { name: "Datadog", ats: "greenhouse", token: "datadog", hiresIn: ["india", "us", "eu", "uk"], tags: ["infra", "observability"] },
  { name: "Temporal", ats: "greenhouse", token: "temporaltechnologies", hiresIn: ["india", "us", "eu"], tags: ["infra"] },
  { name: "CockroachDB", ats: "greenhouse", token: "cockroachlabs", hiresIn: ["india", "us", "uk", "eu"], tags: ["database"] },
  { name: "Neon", ats: "ashby", token: "neon", hiresIn: ["india", "us", "eu"], tags: ["database", "postgres"] },
  { name: "ClickHouse", ats: "ashby", token: "clickhouse", hiresIn: ["india", "us", "eu", "uk", "apac"], tags: ["database"] },
  { name: "Supabase", ats: "ashby", token: "supabase", hiresIn: ["amer", "eu", "apac"], tags: ["database", "postgres", "remote"] },
  { name: "PostHog", ats: "ashby", token: "posthog", hiresIn: ["uk", "us", "eu"], tags: ["devtools", "remote"] },
  { name: "Railway", ats: "ashby", token: "railway", hiresIn: ["anywhere"], tags: ["infra", "remote"] },
  { name: "Resend", ats: "ashby", token: "resend", hiresIn: ["amer", "eu"], tags: ["devtools"] },
  { name: "Linear", ats: "ashby", token: "linear", hiresIn: ["us", "uk", "eu"], tags: ["devtools"] },
  { name: "Highspot", ats: "lever", token: "highspot", hiresIn: ["india", "us", "canada", "uk"], tags: ["saas"] },
  { name: "Rippling", ats: "rippling", token: "rippling", hiresIn: ["india", "us", "canada", "uk"], tags: ["saas", "hr"] },

  // AI
  { name: "Anthropic", ats: "greenhouse", token: "anthropic", hiresIn: ["india", "us", "uk", "eu", "canada"], tags: ["ai"] },
  { name: "OpenAI", ats: "ashby", token: "openai", hiresIn: ["india", "us", "uk", "eu", "apac"], tags: ["ai"] },
  { name: "Databricks", ats: "greenhouse", token: "databricks", hiresIn: ["india", "us", "canada", "uk", "eu", "apac"], tags: ["data", "ai"] },
  { name: "Modal", ats: "ashby", token: "modal", hiresIn: ["us", "uk", "eu"], tags: ["ai", "infra"] },
  { name: "Discord", ats: "greenhouse", token: "discord", hiresIn: ["us", "canada"], tags: ["consumer"] },
  { name: "Vanta", ats: "ashby", token: "vanta", hiresIn: ["us", "uk", "eu", "canada"], tags: ["security", "saas"] },
  { name: "Palantir", ats: "lever", token: "palantir", hiresIn: ["us", "uk", "eu", "canada", "apac", "mena"], tags: ["data"] },
];

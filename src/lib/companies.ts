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
  { name: "Meesho", ats: "lever", token: "meesho", hiresIn: ["india"], tags: ["consumer", "india"] },
  { name: "Zeta", ats: "lever", token: "zeta", hiresIn: ["india"], tags: ["fintech", "india"] },
  { name: "Sarvam AI", ats: "ashby", token: "sarvam", hiresIn: ["india"], tags: ["ai", "india"] },
  { name: "Hevo Data", ats: "lever", token: "hevodata", hiresIn: ["india"], tags: ["data", "india"] },
  { name: "Atlan", ats: "ashby", token: "atlan", hiresIn: ["india"], tags: ["data", "india"] },
  { name: "Swiggy", ats: "smartrecruiters", token: "Swiggy", hiresIn: ["india"], tags: ["consumer", "india"] },
  { name: "Fi Money", ats: "lever", token: "epifi", hiresIn: ["india"], tags: ["fintech", "india"] },
  { name: "Tekion", ats: "greenhouse", token: "tekion", hiresIn: ["india", "us"], tags: ["saas", "india"] },
  { name: "Druva", ats: "greenhouse", token: "druva", hiresIn: ["us", "india", "uk"], tags: ["saas", "india"] },
  { name: "PhonePe", ats: "greenhouse", token: "phonepe", hiresIn: ["india"], tags: ["fintech", "india"] },
  { name: "HackerRank", ats: "greenhouse", token: "hackerrank", hiresIn: ["india", "us", "uk"], tags: ["devtools", "india"] },
  { name: "Mindtickle", ats: "lever", token: "mindtickle", hiresIn: ["india"], tags: ["saas", "india"] },
  { name: "Observe.AI", ats: "greenhouse", token: "observeai", hiresIn: ["india", "us"], tags: ["ai", "india"] },
  { name: "FamPay", ats: "lever", token: "fampay", hiresIn: ["india"], tags: ["fintech", "india"] },
  { name: "Unacademy", ats: "smartrecruiters", token: "unacademy", hiresIn: ["india"], tags: ["edtech", "india"] },
  { name: "Sumo Logic", ats: "greenhouse", token: "sumologic", hiresIn: ["india", "us", "eu", "latam"], tags: ["observability", "india"] },

  // Global product companies with real India engineering centres. These are the
  // ones that pay above the local market without needing a visa.
  { name: "Okta", ats: "greenhouse", token: "okta", hiresIn: ["us", "india", "canada", "eu", "apac", "uk", "latam"], tags: ["security", "saas"] },
  { name: "Zscaler", ats: "greenhouse", token: "zscaler", hiresIn: ["us", "india", "apac", "eu", "uk", "canada"], tags: ["security"] },
  { name: "Twilio", ats: "greenhouse", token: "twilio", hiresIn: ["us", "india", "latam", "eu", "uk", "apac", "canada"], tags: ["saas", "api"] },
  { name: "Harness", ats: "greenhouse", token: "harnessinc", hiresIn: ["us", "india", "uk", "eu"], tags: ["devtools"] },
  { name: "Netskope", ats: "greenhouse", token: "netskope", hiresIn: ["us", "apac", "india", "eu", "latam", "canada"], tags: ["security"] },
  { name: "Fivetran", ats: "greenhouse", token: "fivetran", hiresIn: ["us", "eu", "india", "uk", "apac", "canada"], tags: ["data"] },
  { name: "SingleStore", ats: "greenhouse", token: "singlestore", hiresIn: ["us", "india", "eu"], tags: ["database"] },
  { name: "Couchbase", ats: "greenhouse", token: "couchbaseinc", hiresIn: ["us", "india", "uk", "apac"], tags: ["database"] },
  { name: "Yugabyte", ats: "greenhouse", token: "yugabyte", hiresIn: ["india", "us"], tags: ["database", "postgres"] },
  { name: "Commvault", ats: "greenhouse", token: "commvault", hiresIn: ["us", "apac", "eu", "india", "mena", "uk"], tags: ["saas"] },
  { name: "Rubrik", ats: "greenhouse", token: "rubrik", hiresIn: ["us", "india", "eu", "uk", "apac", "amer", "mena"], tags: ["infra"] },
  { name: "Adyen", ats: "greenhouse", token: "adyen", hiresIn: ["us", "eu", "apac", "latam", "india", "uk"], tags: ["fintech"] },
  { name: "Airbnb", ats: "greenhouse", token: "airbnb", hiresIn: ["us", "apac", "eu", "canada", "latam", "india", "uk"], tags: ["consumer"] },
  { name: "Agoda", ats: "greenhouse", token: "agoda", hiresIn: ["apac", "india", "mena", "us", "canada"], tags: ["consumer", "travel"] },
  { name: "Turing", ats: "greenhouse", token: "turing", hiresIn: ["us", "india", "latam"], tags: ["ai", "remote"] },
  { name: "Confluent", ats: "ashby", token: "confluent", hiresIn: ["us", "india", "canada", "uk", "eu"], tags: ["data", "infra"] },
  { name: "Snowflake", ats: "ashby", token: "snowflake", hiresIn: ["eu", "us", "apac", "uk", "india", "canada", "latam", "mena"], tags: ["data"] },
  { name: "Abnormal Security", ats: "greenhouse", token: "abnormalsecurity", hiresIn: ["us", "india", "eu", "apac", "canada"], tags: ["security"] },
  { name: "ZoomInfo", ats: "greenhouse", token: "zoominfo", hiresIn: ["us", "canada", "india", "eu", "uk"], tags: ["saas", "data"] },
  { name: "Samsara", ats: "greenhouse", token: "samsara", hiresIn: ["us", "canada", "latam", "uk", "eu", "india", "apac"], tags: ["iot", "saas"] },
  { name: "ServiceNow", ats: "smartrecruiters", token: "servicenow", hiresIn: ["us", "apac", "india", "eu"], tags: ["saas"] },
  { name: "Notion", ats: "ashby", token: "notion", hiresIn: ["us", "apac", "eu", "india", "uk"], tags: ["saas", "productivity"] },
  { name: "Workato", ats: "greenhouse", token: "workato", hiresIn: ["eu", "apac", "us", "india", "uk", "latam"], tags: ["saas", "automation"] },
  { name: "Figma", ats: "greenhouse", token: "figma", hiresIn: ["us", "apac", "uk", "eu", "latam", "mena", "india"], tags: ["design", "saas"] },

  // Quant / trading — small India headcount, but the top of the pay band.
  { name: "Tower Research", ats: "greenhouse", token: "towerresearchcapital", hiresIn: ["apac", "us", "india", "uk", "canada"], tags: ["quant", "fintech"] },
  { name: "Squarepoint", ats: "greenhouse", token: "squarepointcapital", hiresIn: ["us", "india", "canada", "uk", "apac"], tags: ["quant", "fintech"] },
  { name: "IMC Trading", ats: "greenhouse", token: "imc", hiresIn: ["us", "eu", "apac", "india", "uk"], tags: ["quant", "fintech"] },

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
  { name: "JFrog", ats: "greenhouse", token: "jfrog", hiresIn: ["mena", "india", "uk", "us", "apac", "eu"], tags: ["devtools"] },
  { name: "Starburst", ats: "greenhouse", token: "starburst", hiresIn: ["us", "india", "eu"], tags: ["data"] },
  { name: "Aerospike", ats: "greenhouse", token: "aerospike", hiresIn: ["us", "india", "mena", "uk", "apac"], tags: ["database"] },
  { name: "Redis", ats: "ashby", token: "redis", hiresIn: ["us", "uk", "eu", "india", "canada", "mena"], tags: ["database"] },
  { name: "Imply", ats: "greenhouse", token: "imply", hiresIn: ["us", "india", "apac"], tags: ["database", "data"] },
  { name: "Cribl", ats: "greenhouse", token: "cribl", hiresIn: ["us", "apac", "eu", "india", "uk"], tags: ["observability"] },

  // AI
  { name: "Anthropic", ats: "greenhouse", token: "anthropic", hiresIn: ["india", "us", "uk", "eu", "canada"], tags: ["ai"] },
  { name: "OpenAI", ats: "ashby", token: "openai", hiresIn: ["india", "us", "uk", "eu", "apac"], tags: ["ai"] },
  { name: "Databricks", ats: "greenhouse", token: "databricks", hiresIn: ["india", "us", "canada", "uk", "eu", "apac"], tags: ["data", "ai"] },
  { name: "Modal", ats: "ashby", token: "modal", hiresIn: ["us", "uk", "eu"], tags: ["ai", "infra"] },
  { name: "Discord", ats: "greenhouse", token: "discord", hiresIn: ["us", "canada"], tags: ["consumer"] },
  { name: "Vanta", ats: "ashby", token: "vanta", hiresIn: ["us", "uk", "eu", "canada"], tags: ["security", "saas"] },
  { name: "Palantir", ats: "lever", token: "palantir", hiresIn: ["us", "uk", "eu", "canada", "apac", "mena"], tags: ["data"] },
];

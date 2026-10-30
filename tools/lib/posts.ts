/**
 * Turns a LinkedIn post into something an agent can act on without reading it.
 *
 * Post search is the channel that has actually produced shortlists (recruiter
 * posts with a Google Form), but it returns everything that mentions the words:
 * people announcing they're open to work, roles in Lahore or Jakarta, unpaid
 * internships, 6+ year asks. In one 38-post sample, five were worth opening.
 * Reading all 38 is what an agent was doing, and it's the expensive part, so
 * the triage happens here and the agent gets one ranked line per post.
 *
 * Everything below is a heuristic over free text. It is tuned to drop the
 * obvious misses and keep anything ambiguous: a post it can't place (no
 * location, no years) is kept and scored, not dropped.
 */
import { profile } from "@/lib/profile";
import { isEngineeringRole, scoreJob } from "@/lib/scoring";
import { locationVerdict } from "@/lib/location-pref";
import { LINKEDIN_COMPANY } from "./linkedin";

export interface RawPost {
  /** innerText of the post, "Feed post" prefix already stripped. */
  text: string;
  /** Resolved outbound links. */
  links: string[];
  post: string | null;
}

export type ApplyKind = "google-form" | "ats" | "careers" | "email" | "dm" | "none";

export interface TriagedPost {
  author: string;
  authorRole: string;
  age: string;
  role: string;
  company: string;
  location: string;
  yoe: { min: number; max: number | null } | null;
  apply: { kind: ApplyKind; target: string | null };
  score: number;
  reasons: string[];
  /** Why it was dropped, when it was. */
  drop: string | null;
  text: string;
  post: string | null;
}

const OPEN_TO_WORK =
  /#opentowork|open to (new )?(work|opportunities|roles)|i'?m (actively )?(looking|seeking|available)|available to (start|join) immediately|seeking (entry[- ]level |new )?(career )?opportunit/i;
const HIRING =
  /we'?re hiring|we are hiring|#hiring|\bhiring\b|is hiring|looking for (a|an|talented|skilled|experienced)|job opening|openings? for|urgent(ly)? (hiring|requirement)|walk-?in/i;
const INTERN = /\bintern(ship)?s?\b|\bunpaid\b|\bstipend\b|\bfreshers? only\b/i;

const INDIA_PLACES = [
  "bengaluru", "bangalore", "pune", "mumbai", "navi mumbai", "thane", "hyderabad", "chennai", "noida",
  "gurgaon", "gurugram", "delhi", "new delhi", "ncr", "kolkata", "ahmedabad", "jaipur", "indore", "kochi",
  "cochin", "mohali", "chandigarh", "coimbatore", "madurai", "nagpur", "trivandrum", "thiruvananthapuram",
  "bhubaneswar", "lucknow", "vadodara", "surat", "mysore", "mysuru", "visakhapatnam", "vizag", "india",
  "pan india", "pan-india",
];
const ABROAD =
  /\b(jakarta|indonesia|lahore|karachi|islamabad|pakistan|dhaka|bangladesh|uae|dubai|abu dhabi|saudi|riyadh|qatar|doha|singapore|malaysia|philippines|manila|nigeria|lagos|kenya|nairobi|usa|united states|canada|toronto|uk|london|germany|berlin|netherlands|amsterdam|australia|sydney|vietnam|egypt|cairo|nepal|sri lanka)\b/i;
const REMOTE = /\bremote\b|work from home|\bwfh\b/i;

function firstMatch(text: string, res: RegExp[]): string | null {
  for (const re of res) {
    const m = text.match(re);
    if (m?.[1]) return m[1].replace(/\s+/g, " ").trim();
  }
  return null;
}

/** "2–3 Years", "3+ yrs", "4 to 6 years", "minimum 2 years". */
export function parsePostYoe(text: string): { min: number; max: number | null } | null {
  const range = text.match(/(\d{1,2})\s*(?:\+\s*)?(?:-|–|—|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)/i);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const plus = text.match(/(?:minimum|min\.?|at least|atleast)?\s*(\d{1,2})\s*\+\s*(?:years?|yrs?)/i) ??
    text.match(/(?:minimum|min\.?|at least|atleast)\s*(\d{1,2})\s*(?:years?|yrs?)/i);
  if (plus) return { min: Number(plus[1]), max: null };
  const exp = text.match(/experience\s*[:\-–]?\s*(\d{1,2})\s*(?:years?|yrs?)/i);
  if (exp) return { min: Number(exp[1]), max: Number(exp[1]) };
  return null;
}

function parseLocation(text: string): string {
  const labelled = firstMatch(text, [
    /(?:📍|location|job location|work location|based in)\s*[:\-–]?\s*([A-Za-z][A-Za-z ,()/.-]{2,60}?)(?=\s*(?:[|💼🏢⏳🕒💰📄🛠️🔑✅🎯📩⚡]|experience|employment|work mode|salary|ctc|notice|$))/i,
  ]);
  if (labelled) return labelled.replace(/[,\s]+$/, "");
  const lower = text.toLowerCase();
  const city = INDIA_PLACES.find((p) => new RegExp(`\\b${p}\\b`).test(lower));
  if (city) return city.replace(/\b\w/g, (c) => c.toUpperCase());
  const abroad = text.match(ABROAD)?.[0];
  return abroad ?? (REMOTE.test(text) ? "Remote" : "");
}

function parseRole(body: string): string {
  return (
    firstMatch(body, [
      /(?:position|role|job title|designation)\s*[:\-–]\s*([^\n|📍💼🏢⏳]{3,70})/i,
      /hiring\s*(?:[|:!\-–]\s*)+(?:for\s+)?(?:an?\s+)?([A-Za-z][^\n|📍💼🏢⏳🚀!]{3,70})/i,
      /(?:hiring|looking for)\s+(?:for\s+)?(?:an?\s+)?(?:talented |skilled |experienced |passionate )?([A-Z][A-Za-z0-9.+#/ ()-]{3,60}?(?:developer|engineer|sde[- ]?\w*|programmer|architect|lead))/i,
    ]) ?? ""
  ).replace(/[\s|:–-]+$/, "");
}

function parseCompany(body: string, authorRole: string): string {
  return (
    firstMatch(body, [
      /(?:company|organi[sz]ation|client)\s*[:\-–]\s*([^\n|📍💼🏢⏳]{2,60})/i,
      /\b(?:at|join)\s+([A-Z][\w&.]*(?:\s+[A-Z][\w&.]*){0,4})(?=[\s,!.]|$)/,
      /([A-Z][\w&.]*(?:\s+[A-Z][\w&.]*){0,4})\s+is\s+(?:hiring|looking)/,
    ]) ??
    firstMatch(authorRole, [/@\s*([^|]+)/, /\bat\s+([^|]+)/]) ??
    ""
  ).replace(/\s*(?:pvt\.?|private)?\s*(?:ltd\.?|limited)?\s*$/i, "").trim();
}

function classifyApply(links: string[], body: string): { kind: ApplyKind; target: string | null } {
  const form = links.find((l) => /docs\.google\.com\/forms|forms\.gle/.test(l));
  if (form) return { kind: "google-form", target: form };
  const ats = links.find((l) => /greenhouse|lever\.co|ashbyhq|myworkdayjobs|smartrecruiters|workable|keka|darwinbox|zohorecruit|freshteam|naukri/.test(l));
  if (ats) return { kind: "ats", target: ats };
  const careers = links.find((l) => /career|jobs?\b|apply|hiring/i.test(l) && !/linkedin\.com/.test(l));
  if (careers) return { kind: "careers", target: careers };
  const email = body.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0]?.replace(/[.,;]+$/, "");
  if (email) return { kind: "email", target: email };
  if (/\bdm\b|inbox me|message me|comment ["']?interested/i.test(body)) return { kind: "dm", target: null };
  return { kind: "none", target: null };
}

/**
 * Header lines LinkedIn puts before the body: "Name • 2nd Headline 3h Follow".
 * Split on the age token, which every post has.
 */
function splitHeader(text: string): { author: string; authorRole: string; age: string; body: string } {
  const m = text.match(/^(.*?)\s+((?:\d+[mhdw])|yesterday|just now|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2})(?:\s*•\s*edited)?\s+(?:follow|connect|\+ follow)?\s*/i);
  if (!m) return { author: "", authorRole: "", age: "", body: text };
  const head = m[1];
  const author = head.split(/\s+•\s+/)[0].replace(/\s*(verified profile)?$/i, "").trim();
  const authorRole = head.replace(/^.*?(?:•\s*(?:1st|2nd|3rd\+?)\s*)/i, "").trim();
  return { author, authorRole, age: m[2], body: text.slice(m[0].length) };
}

export interface TriageOptions {
  includeInternships?: boolean;
  /** Keep roles asking for more than this many years above yours. */
  maxYoeGap?: number;
}

export function triagePost(p: RawPost, o: TriageOptions = {}): TriagedPost {
  const { author, authorRole, age, body } = splitHeader(p.text);
  const role = parseRole(body);
  const company = parseCompany(body, authorRole);
  const location = parseLocation(body);
  const yoe = parsePostYoe(body);
  const apply = classifyApply(p.links, body);

  let drop: string | null = null;
  const where = locationVerdict(location, body);
  const indiaish = INDIA_PLACES.some((c) => new RegExp(`\\b${c}\\b`, "i").test(location)) || /remote/i.test(location);
  if (OPEN_TO_WORK.test(body) && !/we'?re hiring|we are hiring/i.test(body)) drop = "open-to-work post, not a role";
  else if (!HIRING.test(body)) drop = "not a hiring post";
  else if (role && !isEngineeringRole(role)) drop = `not an engineering role (${role.slice(0, 40)})`;
  else if (!where.ok) drop = where.why;
  else if (/\b(indonesian|pakistani|uae nationals?|us citizens?) (candidates )?only\b/i.test(body)) drop = "restricted to another country's candidates";
  else if (!o.includeInternships && INTERN.test(`${role} ${body.slice(0, 200)}`)) drop = "internship";
  else if (yoe && yoe.min - profile.yearsExperience > (o.maxYoeGap ?? 2)) drop = `asks ${yoe.min}+ years`;

  const s = scoreJob(
    {
      title: role || body.slice(0, 80),
      description: body,
      location,
      locations: [location],
      countryCode: indiaish ? "IN" : null,
    },
    LINKEDIN_COMPANY,
  );
  return {
    author,
    authorRole,
    age,
    role: role || "(role unclear)",
    company: company || "(company unclear)",
    location: where.label,
    yoe,
    apply,
    score: s.score,
    reasons: s.reasons,
    drop,
    text: body,
    post: p.post,
  };
}

/** Same post reshared by several recruiters: keep the first. */
export function dedupePosts(posts: TriagedPost[]): TriagedPost[] {
  const seen = new Set<string>();
  return posts.filter((p) => {
    const k = p.text.slice(0, 160).toLowerCase().replace(/\W+/g, "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function formatPost(p: TriagedPost, n: number, textChars: number): string {
  const yoe = p.yoe ? `${p.yoe.min}${p.yoe.max != null && p.yoe.max !== p.yoe.min ? `-${p.yoe.max}` : "+"}y` : "?y";
  const apply = p.apply.target ? `${p.apply.kind} ${p.apply.target}` : p.apply.kind;
  const lines = [
    `#${n} ${p.score} | ${p.role} | ${p.company} | ${p.location} | ${yoe} | ${p.age} | apply: ${apply}`,
    `   by ${p.author}${p.authorRole ? ` (${p.authorRole.slice(0, 60)})` : ""} | ${p.reasons.slice(0, 3).join("; ")}`,
  ];
  if (textChars > 0) lines.push(`   ${p.text.slice(0, textChars)}`);
  if (p.post) lines.push(`   post: ${p.post}`);
  return lines.join("\n");
}

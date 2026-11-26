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
import { fitGate } from "@/lib/gate";
import { applyRoute, competition, noticeAsk, type NoticeAsk } from "@/lib/signals";
import { LINKEDIN_COMPANY } from "./linkedin";

export interface RawPost {
  /** innerText of the post, "Feed post" prefix already stripped. */
  text: string;
  /** Resolved outbound links. */
  links: string[];
  post: string | null;
}

export type ApplyKind = "google-form" | "ats" | "careers" | "email" | "dm" | "none";

/**
 * Who is behind the post. "hiring-manager": a founder, CTO or engineering
 * manager at the employer. "in-house": the employer's own HR or the company
 * page. "agency": a recruiter placing someone else's role.
 */
export type PostSource = "hiring-manager" | "in-house" | "agency" | "unknown";

export interface TriagedPost {
  author: string;
  authorRole: string;
  age: string;
  role: string;
  company: string;
  location: string;
  yoe: { min: number; max: number | null } | null;
  apply: { kind: ApplyKind; target: string | null };
  source: PostSource;
  /** The poster's own employer, from their headline or email domain. */
  authorOrg: string | null;
  /** The notice the post wants, when it says. */
  notice: NoticeAsk | null;
  /** Stated in the post, when it is. */
  pay: string | null;
  score: number;
  reasons: string[];
  /** Why it was dropped, when it was. */
  drop: string | null;
  text: string;
  post: string | null;
}

const OPEN_TO_WORK =
  /#opentowork|open to (new )?(work|opportunities|roles)|i['’]?m (actively )?(looking|seeking|available)|my next (challenge|role|opportunity)|(officially )?on the (job )?market|available to (start|join) immediately|seeking (entry[- ]level |new )?(career )?opportunit/i;
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

const stripLegal = (s: string) => s.replace(/\s*(?:pvt\.?|private)?\s*(?:ltd\.?|limited)?\s*$/i, "").trim();

/** The employer named in the post body, or "" when it names none. */
function parseCompany(body: string): string {
  const c = stripLegal(
    firstMatch(body, [
      /(?:company|organi[sz]ation|client)\s*[:\-–]\s*([^\n|📍💼🏢⏳]{2,60})/i,
      /\b(?:at|join)\s+([A-Z][\w&.]*(?:\s+[A-Z][\w&.]*){0,4})(?=[\s,!.]|$)/,
      /([A-Z][\w&.]*(?:\s+[A-Z][\w&.]*){0,4})\s+is\s+(?:hiring|looking)/,
    ]) ?? "",
  );
  // "Hiring for our client: Backend Engineer (Python), Location: ..." puts the role where the name would be.
  return /developer|engineer|location|experience|\byears?\b/i.test(c) ? "" : c;
}

/** Company pages render their name twice: "Sumfive Technologies Sumfive Technologies". */
const once = (s: string) => s.replace(/^(.{3,}?)\s+\1$/, "$1");

const AGENCY =
  /for (?:one of )?our (?:esteemed |reputed |leading |valued )?clients?|on behalf of|client of ours|\bour client\b|staffing|placement|manpower|recruitment (?:agency|firm|services|partner)|talent solutions|hiring partner|\brpo\b|\bc2c\b|bench sales|consultancy|it consulting|headhunt/i;
const MANAGER_ROLE =
  /\b(cto|ceo|founder|co-?founder|vp,? engineering|head of (?:engineering|technology|tech)|engineering manager|director of engineering|tech(?:nical)? lead|team lead)\b/i;
const FREEMAIL = /^(gmail|googlemail|yahoo|outlook|hotmail|rediffmail|icloud|proton|protonmail|live|ymail|aol)$/i;
const ORG_NOISE = /\b(pvt|private|ltd|limited|inc|llp|llc|technologies|technology|tech|solutions|software|systems|labs?|india|global|group|services|consulting|the)\b/g;

/** "4Labs Technologies Pvt Ltd" and "4labsinc.com" are the same org; "ApTask" and "Kinaxis" are not. */
export function sameOrg(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(ORG_NOISE, " ").replace(/[^a-z0-9]+/g, " ").trim();
  const [x, y] = [n(a), n(b)];
  if (!x || !y) return false;
  const [fx, fy] = [x.split(" ")[0], y.split(" ")[0]];
  return x === y || (fx.length >= 3 && y.replace(/ /g, "").includes(fx)) || (fy.length >= 3 && x.replace(/ /g, "").includes(fy));
}

/** The poster's employer: "HR Recruiter @ 4Labs Technologies | MBA" -> "4Labs Technologies", else the email domain. */
function authorOrgOf(author: string, authorRole: string, body: string): string | null {
  const head = firstMatch(authorRole, [/@\s*([^|•,()]{2,50})/, /\bat\s+([A-Z0-9][^|•,()]{1,50})/]);
  if (head) return stripLegal(head);
  // A company page posts as itself: the "author" is the company and its "headline" repeats it.
  if (author && authorRole && sameOrg(author, authorRole) && !/\b(hr|recruit|talent)/i.test(authorRole)) return author;
  const domain = body.match(/[\w.+-]+@([\w-]+)\.[\w.-]+/)?.[1];
  return domain && !FREEMAIL.test(domain) ? domain : null;
}

function classifySource(body: string, author: string, authorRole: string, employer: string, org: string | null): PostSource {
  if (AGENCY.test(body) || AGENCY.test(authorRole)) return "agency";
  if (employer && org && !sameOrg(employer, org)) return "agency";
  const own = (employer && org && sameOrg(employer, org)) || (!employer && org && /\b(we(?:'re| are)|our (?:team|company)|join us)\b/i.test(body));
  if (!own) return "unknown";
  return MANAGER_ROLE.test(authorRole) && !sameOrg(author, org!) ? "hiring-manager" : "in-house";
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
}

export function triagePost(p: RawPost, o: TriageOptions = {}): TriagedPost {
  const h = splitHeader(p.text);
  const { age, body } = h;
  const author = once(h.author);
  const authorRole = once(h.authorRole);
  const role = parseRole(body);
  const employer = parseCompany(body);
  const authorOrg = authorOrgOf(author, authorRole, body);
  const source = classifySource(body, author, authorRole, employer, authorOrg);
  // An in-house post that names no employer is for the poster's own company.
  const company = employer || (source === "in-house" || source === "hiring-manager" ? authorOrg ?? "" : "");
  const location = parseLocation(body);
  const yoe = parsePostYoe(body);
  const apply = classifyApply(p.links, body);
  const route = applyRoute(apply.kind);
  const fresh = competition(null, age);
  const notice = noticeAsk(body);

  let drop: string | null = null;
  const gate = fitGate({ title: role || body.slice(0, 80), location, description: body, yoe });
  const indiaish = INDIA_PLACES.some((c) => new RegExp(`\\b${c}\\b`, "i").test(location)) || /remote/i.test(location);
  if (OPEN_TO_WORK.test(body) && !/we['’]?re hiring|we are hiring/i.test(body)) drop = "open-to-work post, not a role";
  else if (!HIRING.test(body)) drop = "not a hiring post";
  else if (profile.repostBlocklist.some((n) => `${author} ${company}`.toLowerCase().includes(n))) drop = "reposter, employer hidden";
  else if (role && !isEngineeringRole(role)) drop = `not an engineering role (${role.slice(0, 40)})`;
  else if (/\b(indonesian|pakistani|uae nationals?|us citizens?) (candidates )?only\b/i.test(body)) drop = "restricted to another country's candidates";
  else if (!o.includeInternships && INTERN.test(`${role} ${body.slice(0, 200)}`)) drop = "internship";
  else if (!gate.ok) drop = gate.why;

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
    source,
    authorOrg,
    location: gate.where,
    pay: gate.pay,
    yoe,
    apply,
    // Posts carry no applicant count, so crowding is age alone. Not clamped at
    // 100: it's a rank, and a capped score would tie the best posts together.
    score: Math.max(0, s.score + profile.postSource[source] + route.points + fresh.points),
    reasons: [
      notice?.short ? `NOTICE: ${notice.label}` : null,
      source === "unknown" ? null : `via ${source}${authorOrg ? ` (${authorOrg})` : ""}`,
      fresh.label,
      ...s.reasons,
    ].filter((r): r is string => !!r),
    notice,
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
    `#${n} ${p.score} | ${p.role} | ${p.company} | ${p.location} | ${yoe}${p.pay ? ` | ${p.pay}` : ""} | ${p.age} | apply: ${apply}`,
    `   by ${p.author}${p.authorRole ? ` (${p.authorRole.slice(0, 60)})` : ""} | ${p.reasons.slice(0, 3).join("; ")}`,
  ];
  if (textChars > 0) lines.push(`   ${p.text.slice(0, textChars)}`);
  if (p.post) lines.push(`   post: ${p.post}`);
  return lines.join("\n");
}

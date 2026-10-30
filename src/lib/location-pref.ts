import { profile } from "./profile";

/**
 * Does a role's location suit you, per `profile.locations`?
 *
 * `location` is the posting's location string; `text` is the description or
 * post body, which is where "remote", "visa sponsorship" and "relocation" are
 * usually stated. Unknown locations pass: a post that doesn't say is worth a
 * look, not a silent drop.
 */
export interface LocationVerdict {
  ok: boolean;
  /** Short label for the row: "Pune", "remote (US)", "abroad, sponsored". */
  label: string;
  /** Why it failed, when it did. */
  why: string | null;
}

const INDIA = [
  "india", "pan india", "pan-india", "bengaluru", "bangalore", "pune", "mumbai", "navi mumbai", "thane",
  "hyderabad", "chennai", "noida", "gurgaon", "gurugram", "delhi", "new delhi", "ncr", "kolkata",
  "ahmedabad", "jaipur", "indore", "kochi", "cochin", "mohali", "chandigarh", "coimbatore", "madurai",
  "nagpur", "trivandrum", "thiruvananthapuram", "bhubaneswar", "lucknow", "vadodara", "surat", "mysore",
  "mysuru", "visakhapatnam", "vizag", "karnataka", "maharashtra", "telangana", "tamil nadu",
];
/** How posts actually write your cities: short forms and the suburbs people name instead. */
const CITY_ALIASES: Record<string, string> = {
  hyd: "hyderabad", secunderabad: "hyderabad", hitech: "hyderabad", gachibowli: "hyderabad",
  blr: "bangalore", bengaluru: "bangalore", whitefield: "bangalore", "electronic city": "bangalore",
  bom: "mumbai", andheri: "mumbai", powai: "mumbai", bkc: "mumbai", chandivali: "mumbai", malad: "mumbai",
  goregaon: "mumbai", vikhroli: "mumbai", thane: "mumbai", "navi mumbai": "mumbai",
  pimpri: "pune", chinchwad: "pune", hinjewadi: "pune", kharadi: "pune", baner: "pune", magarpatta: "pune",
};
/** Places that are clearly not India. Anything else unrecognised counts as unknown and is kept. */
const ABROAD =
  /\b(jakarta|indonesia|lahore|karachi|islamabad|pakistan|dhaka|bangladesh|uae|dubai|abu dhabi|saudi|riyadh|qatar|doha|singapore|malaysia|philippines|manila|nigeria|lagos|kenya|nairobi|usa|united states|canada|toronto|uk|united kingdom|london|germany|berlin|netherlands|amsterdam|australia|sydney|vietnam|egypt|cairo|nepal|sri lanka|jersey|texas|california|new york)\b/i;
const US = /\b(us|usa|united states|u\.s\.?|americas?|north america)\b/i;
const ANYWHERE = /\b(anywhere|worldwide|global(ly)?|any location|fully distributed)\b/i;
const REMOTE = /\bremote\b|work from home|\bwfh\b|fully distributed/i;
const SPONSOR = /visa sponsorship|sponsor(s|ing)? (your |the |a )?(work )?visa|relocation (support|assistance|package|bonus)|we (will )?relocate|help(s)? (you )?relocate/i;
const NO_SPONSOR = /no (visa )?sponsorship|(not|unable to|cannot|can't|do not|don't) (provide |offer )?(visa )?sponsor/i;

const has = (hay: string, words: readonly string[]) =>
  words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(hay));

export function locationVerdict(location: string, text = ""): LocationVerdict {
  const pref = profile.locations;
  const loc = location.trim();
  const remote = REMOTE.test(loc) || (!loc && REMOTE.test(text.slice(0, 600)));

  if (remote && pref.remote) {
    if (has(loc, INDIA) || /india/i.test(text.slice(0, 600))) return { ok: true, label: "remote (India)", why: null };
    if (US.test(loc) || US.test(text.slice(0, 600))) return { ok: true, label: "remote (US)", why: null };
    if (ANYWHERE.test(loc) || ANYWHERE.test(text.slice(0, 600)) || !loc || /^remote$/i.test(loc)) {
      return { ok: true, label: "remote", why: null };
    }
    // "Remote (Pakistan)", "Remote - UK only": remote, but not open to you.
    return { ok: false, label: loc, why: `remote, but limited to ${loc.replace(/^remote\W*/i, "") || loc}` };
  }

  if (!loc) return { ok: true, label: "location unstated", why: null };
  if (has(loc, pref.cities) || has(loc, Object.keys(CITY_ALIASES))) return { ok: true, label: loc, why: null };
  if (has(loc, INDIA)) {
    return { ok: false, label: loc, why: `on-site in ${loc}, not one of your cities` };
  }
  // Neither India nor anywhere recognisably abroad ("Multiple locations"): keep it.
  if (!ABROAD.test(loc)) return { ok: true, label: loc, why: null };
  // Somewhere outside India.
  if (pref.abroadIfSponsored && SPONSOR.test(text) && !NO_SPONSOR.test(text)) {
    return { ok: true, label: `${loc}, sponsored`, why: null };
  }
  return { ok: false, label: loc, why: `on-site in ${loc} with no visa sponsorship mentioned` };
}

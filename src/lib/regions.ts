/**
 * Where a role can actually be worked from.
 *
 * ATS boards express this as free text ("Hybrid - Bangalore, India", "Remote
 * (EMEA)", "AMER", "Alberta; British Columbia", "Global"), so this module turns
 * that mess into a small set of regions we can reason about. It exists because
 * "remote" alone is a useless signal: a US-remote role and an India-remote role
 * look identical in a location string but are worlds apart for eligibility.
 */

export type Region =
  | "india"
  | "apac"
  | "us"
  | "canada"
  | "latam"
  | "amer"
  | "uk"
  | "eu"
  | "emea"
  | "mena"
  | "anywhere";

/**
 * Broad regions imply the narrower ones inside them. Used so a posting tagged
 * "APAC" can be reasoned about against a profile based in India.
 */
const COVERS: Partial<Record<Region, Region[]>> = {
  anywhere: ["india", "apac", "us", "canada", "latam", "amer", "uk", "eu", "emea", "mena"],
  apac: ["india"],
  amer: ["us", "canada", "latam"],
  emea: ["uk", "eu", "mena"],
};

/** True if `broad` includes `target` (or is exactly it). */
export function regionCovers(broad: Region, target: Region): boolean {
  return broad === target || (COVERS[broad]?.includes(target) ?? false);
}

/**
 * Ordered matchers — first match per segment wins, so specific patterns
 * (Bangalore) must come before broad ones (APAC).
 */
const MATCHERS: [Region, RegExp][] = [
  [
    "india",
    /\b(india|indian|bengaluru|bangalore|blr|pune|hyderabad|mumbai|new delhi|delhi ncr|delhi|gurgaon|gurugram|noida|chennai|kolkata|ahmedabad|jaipur|indore|kochi|coimbatore|thiruvananthapuram|trivandrum)\b/i,
  ],
  [
    "us",
    /\b(united states|u\.?s\.?a?\.?|usa|new york|nyc|san francisco|sf bay|bay area|seattle|austin|boston|chicago|denver|los angeles|atlanta|miami|dallas|houston|phoenix|portland|san diego|san jose|palo alto|menlo park|mountain view|bellevue|washington,? d\.?c\.?|remote ?[-(]? ?us)\b/i,
  ],
  [
    // Trailing US state codes ("Austin, TX"). "IN" is deliberately excluded —
    // Indiana is far rarer here than a mis-parse of an Indian location.
    "us",
    /,\s*(al|ak|az|ar|ca|co|ct|fl|ga|id|il|ia|ks|ky|la|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/i,
  ],
  [
    "canada",
    /\b(canada|canadian|toronto|vancouver|montreal|ottawa|calgary|alberta|british columbia|manitoba|nova scotia|ontario|quebec|saskatchewan)\b/i,
  ],
  [
    "latam",
    /\b(latam|latin america|brazil|brasil|mexico|argentina|colombia|chile|peru|uruguay|costa rica|s[aã]o paulo|buenos aires|bogot[aá]|mexico city)\b/i,
  ],
  ["amer", /\b(amer|americas|north america)\b/i],
  [
    "uk",
    /\b(united kingdom|u\.?k\.?|england|scotland|wales|northern ireland|london|manchester|edinburgh|cambridge|bristol)\b/i,
  ],
  [
    "eu",
    /\b(europe|european|eea|germany|berlin|munich|france|paris|netherlands|amsterdam|spain|madrid|barcelona|italy|milan|rome|poland|warsaw|krak[oó]w|sweden|stockholm|denmark|copenhagen|aarhus|norway|oslo|finland|helsinki|ireland|dublin|portugal|lisbon|austria|vienna|switzerland|zurich|belgium|brussels|czech|prague|romania|bucharest|greece|athens)\b/i,
  ],
  ["mena", /\b(mena|middle east|uae|u\.a\.e\.|dubai|abu dhabi|saudi|qatar|doha|israel|tel aviv|egypt|cairo|t[uü]rkiye|turkey|istanbul)\b/i],
  [
    "apac",
    /\b(apac|apj|aparc|asia[- ]pacific|asia|singapore|japan|tokyo|australia|sydney|melbourne|new zealand|auckland|korea|seoul|china|shanghai|beijing|hong kong|taiwan|taipei|indonesia|jakarta|malaysia|kuala lumpur|philippines|manila|thailand|bangkok|vietnam|hanoi)\b/i,
  ],
  ["anywhere", /\b(anywhere|worldwide|global|globally|distributed|fully remote|remote[- ]first)\b/i],
];

/** ISO country codes some boards (Lever) hand us directly — the cleanest signal. */
const COUNTRY_CODES: Record<string, Region> = {
  IN: "india",
  US: "us",
  CA: "canada",
  GB: "uk",
  UK: "uk",
  IE: "eu", DE: "eu", FR: "eu", NL: "eu", ES: "eu", IT: "eu", PL: "eu",
  SE: "eu", DK: "eu", NO: "eu", FI: "eu", PT: "eu", AT: "eu", CH: "eu",
  BE: "eu", CZ: "eu", RO: "eu", GR: "eu",
  BR: "latam", MX: "latam", AR: "latam", CO: "latam", CL: "latam",
  AE: "mena", SA: "mena", QA: "mena", IL: "mena", EG: "mena", TR: "mena",
  SG: "apac", JP: "apac", AU: "apac", NZ: "apac", KR: "apac", CN: "apac",
  HK: "apac", TW: "apac", ID: "apac", MY: "apac", PH: "apac", TH: "apac", VN: "apac",
};

/**
 * Boards pack several places into one string. Only unambiguous separators are
 * used here — splitting on the word "or" would tear "Portland, OR" in half.
 */
const SEGMENT_SPLIT = /[;|]|\s+\/\s+/;

/**
 * Extract every region mentioned across a set of location strings. Returns an
 * empty array when nothing is recognizable — callers should treat that as
 * "unknown", not as "anywhere".
 */
export function parseRegions(texts: (string | null | undefined)[]): Region[] {
  const found = new Set<Region>();

  for (const raw of texts) {
    if (!raw) continue;
    const trimmed = raw.trim();

    // A bare 2-letter token is almost always an ISO country code from Lever.
    if (/^[A-Za-z]{2}$/.test(trimmed)) {
      const mapped = COUNTRY_CODES[trimmed.toUpperCase()];
      if (mapped) {
        found.add(mapped);
        continue;
      }
    }

    for (const segment of trimmed.split(SEGMENT_SPLIT)) {
      const s = segment.trim();
      if (!s) continue;
      for (const [region, re] of MATCHERS) {
        if (re.test(s)) {
          found.add(region);
          break; // first (most specific) match wins for this segment
        }
      }
    }
  }

  return [...found];
}

/** True if any posted region covers where you actually are. */
export function regionsInclude(regions: Region[], target: Region): boolean {
  return regions.some((r) => regionCovers(r, target));
}

const LABELS: Record<Region, string> = {
  india: "India",
  apac: "APAC",
  us: "US",
  canada: "Canada",
  latam: "LatAm",
  amer: "Americas",
  uk: "UK",
  eu: "Europe",
  emea: "EMEA",
  mena: "MENA",
  anywhere: "Anywhere",
};

export const regionLabel = (r: Region) => LABELS[r];

import type { Company } from "../companies";
import { descriptionCouldMatter, hydrate } from "./detail";
import {
  fetchJson,
  htmlToText,
  looksRemote,
  type Connector,
  type FetchResult,
  type RawPosting,
} from "./types";

interface SrLocation {
  city?: string;
  region?: string;
  country?: string;
  remote?: boolean;
  fullLocation?: string;
}

interface SrPosting {
  id: string;
  name: string;
  releasedDate?: string;
  location?: SrLocation;
  department?: { label?: string };
  function?: { label?: string };
}

interface SrPage {
  offset?: number;
  limit?: number;
  totalFound?: number;
  content?: SrPosting[];
}

interface SrDetail {
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: {
    sections?: Record<string, { title?: string; text?: string } | undefined>;
  };
}

const API = "https://api.smartrecruiters.com/v1/companies";

/** Max the API accepts per page. */
const PAGE_SIZE = 100;

/** Ceiling on list pages per board — 600 postings is far more than we rank. */
const MAX_PAGES = 6;

function toPosting(company: Company, p: SrPosting): RawPosting {
  const loc = p.location ?? {};
  const location =
    loc.fullLocation ??
    [loc.city, loc.region, loc.country].filter(Boolean).join(", ");

  return {
    externalId: p.id,
    title: p.name,
    location,
    locations: [location].filter(Boolean),
    // The API gives lowercase ISO ("in"); regions.ts matches on uppercase.
    countryCode: loc.country ? loc.country.toUpperCase() : null,
    // Replaced with the canonical postingUrl if this posting gets hydrated.
    url: `https://jobs.smartrecruiters.com/${company.token}/${p.id}`,
    remote: loc.remote === true || looksRemote(location),
    department: p.department?.label ?? p.function?.label ?? "",
    description: "",
    postedAt: p.releasedDate ? new Date(p.releasedDate) : null,
  };
}

/**
 * SmartRecruiters. The list call is paginated and carries no description, so
 * this is a page-through plus selective detail fetches (see ./detail.ts).
 *
 * No conditional caching: the board spans several pages and an ETag on page one
 * says nothing about pages two through four, so claiming a board is "unchanged"
 * off the back of it would silently freeze half of it. Everything the list call
 * needs for ranking — title, location, posted date — is in the list itself, so
 * the cost of re-reading it is a few hundred KB, not megabytes.
 */
export const smartrecruiters: Connector = {
  async fetch(company: Company): Promise<FetchResult> {
    const postings: RawPosting[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${API}/${company.token}/postings?limit=${PAGE_SIZE}&offset=${
        page * PAGE_SIZE
      }`;
      const res = await fetchJson(url);
      const data = res.data as SrPage;
      const content = data.content ?? [];

      postings.push(...content.map((p) => toPosting(company, p)));

      if (content.length < PAGE_SIZE) break;
      if (postings.length >= (data.totalFound ?? 0)) break;
    }

    await hydrate(
      postings.filter(descriptionCouldMatter),
      async (posting) => {
        const res = await fetchJson(
          `${API}/${company.token}/postings/${posting.externalId}`,
        );
        const detail = res.data as SrDetail;

        const sections = Object.values(detail.jobAd?.sections ?? {})
          .map((s) => s?.text ?? "")
          .filter(Boolean)
          .join(" ");
        posting.description = htmlToText(sections);

        const canonical = detail.postingUrl ?? detail.applyUrl;
        if (canonical) posting.url = canonical;
      },
    );

    return {
      postings,
      etag: null,
      lastModified: null,
      notModified: false,
    };
  },
};

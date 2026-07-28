import type { Company } from "../companies";
import {
  fetchJson,
  htmlToText,
  looksRemote,
  unchanged,
  type Conditional,
  type Connector,
  type FetchResult,
} from "./types";

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  /** When the posting first went live. The date that actually matters. */
  first_published?: string;
  /** Bumped by any edit, so useless as an age signal. */
  updated_at?: string;
  location?: { name?: string };
  offices?: { name?: string; location?: string }[];
  departments?: { name?: string }[];
  content?: string;
}

export const greenhouse: Connector = {
  async fetch(company: Company, cond?: Conditional): Promise<FetchResult> {
    // `content=true` returns full descriptions in the same call — no N+1.
    const url = `https://boards-api.greenhouse.io/v1/boards/${company.token}/jobs?content=true`;
    const res = await fetchJson(url, cond);
    if (res.notModified) return unchanged(res);

    const data = res.data as { jobs?: GhJob[] };
    const postings = (data.jobs ?? []).map((j) => {
      const location = j.location?.name ?? "";
      const offices = (j.offices ?? [])
        .map((o) => o.location || o.name || "")
        .filter(Boolean);
      return {
        externalId: String(j.id),
        title: j.title,
        location,
        locations: [location, ...offices].filter(Boolean),
        countryCode: null,
        url: j.absolute_url,
        remote: looksRemote(location),
        department: j.departments?.[0]?.name ?? "",
        description: htmlToText(j.content),
        postedAt: j.first_published
          ? new Date(j.first_published)
          : j.updated_at
            ? new Date(j.updated_at)
            : null,
      };
    });

    return {
      postings,
      etag: res.etag,
      lastModified: res.lastModified,
      notModified: false,
    };
  },
};

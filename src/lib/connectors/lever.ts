import type { Company } from "../companies";
import {
  fetchJson,
  looksRemote,
  unchanged,
  type Conditional,
  type Connector,
  type FetchResult,
} from "./types";

interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  createdAt?: number;
  workplaceType?: string;
  /** ISO country code — the cleanest eligibility signal any board gives us. */
  country?: string;
  descriptionPlain?: string;
  additionalPlain?: string;
  lists?: { text?: string; content?: string }[];
  categories?: {
    location?: string;
    allLocations?: string[];
    commitment?: string;
    team?: string;
    department?: string;
  };
}

export const lever: Connector = {
  async fetch(company: Company, cond?: Conditional): Promise<FetchResult> {
    const url = `https://api.lever.co/v0/postings/${company.token}?mode=json`;
    const res = await fetchJson(url, cond);
    if (res.notModified) return unchanged(res);

    const data = res.data as LeverJob[];
    const postings = !Array.isArray(data)
      ? []
      : data.map((j) => {
          const location = j.categories?.location ?? "";
          const all = j.categories?.allLocations ?? [];
          // Requirement bullets live in `lists`, which is where sponsorship and
          // work-authorization lines usually hide.
          const listText = (j.lists ?? [])
            .map((l) => `${l.text ?? ""} ${l.content ?? ""}`)
            .join(" ");
          return {
            externalId: j.id,
            title: j.text,
            location,
            locations: [location, ...all].filter(Boolean),
            countryCode: j.country ?? null,
            url: j.hostedUrl ?? j.applyUrl ?? "",
            remote:
              j.workplaceType?.toLowerCase() === "remote" ||
              looksRemote(location),
            department: j.categories?.department ?? j.categories?.team ?? "",
            description: [j.descriptionPlain, listText, j.additionalPlain]
              .filter(Boolean)
              .join(" ")
              .replace(/\s+/g, " ")
              .trim(),
            postedAt: j.createdAt ? new Date(j.createdAt) : null,
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

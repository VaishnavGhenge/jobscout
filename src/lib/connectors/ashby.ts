import type { Company } from "../companies";
import {
  fetchJson,
  looksRemote,
  unchanged,
  type Conditional,
  type Connector,
  type FetchResult,
} from "./types";

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  department?: string;
  employmentType?: string;
  workplaceType?: string;
  isRemote?: boolean;
  isListed?: boolean;
  jobUrl?: string;
  applyUrl?: string;
  publishedAt?: string;
  descriptionPlain?: string;
}

export const ashby: Connector = {
  async fetch(company: Company, cond?: Conditional): Promise<FetchResult> {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${company.token}`;
    const res = await fetchJson(url, cond);
    if (res.notModified) return unchanged(res);

    const data = res.data as { jobs?: AshbyJob[] };
    const postings = (data.jobs ?? [])
      .filter((j) => j.isListed !== false)
      .map((j) => {
        const location = j.location ?? "";
        const secondary = (j.secondaryLocations ?? [])
          .map((s) => s.location ?? "")
          .filter(Boolean);
        return {
          externalId: j.id,
          title: j.title,
          location,
          locations: [location, ...secondary].filter(Boolean),
          countryCode: null,
          url: j.jobUrl ?? j.applyUrl ?? "",
          remote:
            Boolean(j.isRemote) ||
            j.workplaceType?.toLowerCase() === "remote" ||
            looksRemote(location),
          department: j.department ?? "",
          description: (j.descriptionPlain ?? "").replace(/\s+/g, " ").trim(),
          postedAt: j.publishedAt ? new Date(j.publishedAt) : null,
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

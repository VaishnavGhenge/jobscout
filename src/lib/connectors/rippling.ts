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

interface RipListJob {
  uuid: string;
  name: string;
  url?: string;
  department?: { label?: string; id?: string };
  workLocation?: { label?: string };
}

interface RipDetail {
  /** Sections keyed by name ("company", "role", …), each a blob of HTML. */
  description?: Record<string, string>;
  createdOn?: string;
  workLocations?: string[];
  department?: { name?: string; base_department?: string };
}

const API = "https://api.rippling.com/platform/api/ats/v1/board";

/**
 * Rippling ATS.
 *
 * Two things make this board different from the other four:
 *
 * 1. The list call returns neither the description *nor the posted date* — both
 *    live on the per-posting detail call. Freshness is the second-heaviest input
 *    to the score, so a posting we don't hydrate is ranked with an unknown age
 *    (a small penalty) rather than a wrong one. In practice the postings that go
 *    un-hydrated are the ones already blocked on location, which sink anyway.
 * 2. The list repeats postings — one page returned 834 rows for 418 real jobs,
 *    apparently one row per work location. Deduped here on uuid rather than
 *    leaning on the de-dupe in refresh.ts, so the counts this connector reports
 *    are honest.
 *
 * The board also sends `cache-control: no-store` and no ETag, so there's no
 * conditional request to make — we send the validators anyway and the host
 * simply ignores them.
 */
export const rippling: Connector = {
  async fetch(company: Company): Promise<FetchResult> {
    const res = await fetchJson(`${API}/${company.token}/jobs`);
    const rows = (res.data as RipListJob[]) ?? [];

    const unique = new Map<string, RipListJob>();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row?.uuid && !unique.has(row.uuid)) unique.set(row.uuid, row);
    }

    const postings: RawPosting[] = [...unique.values()].map((j) => {
      const location = j.workLocation?.label ?? "";
      return {
        externalId: j.uuid,
        title: j.name,
        location,
        locations: [location].filter(Boolean),
        countryCode: null,
        url: j.url ?? `https://ats.rippling.com/${company.token}/jobs/${j.uuid}`,
        remote: looksRemote(location),
        department: j.department?.label ?? "",
        description: "",
        postedAt: null,
      };
    });

    await hydrate(postings.filter(descriptionCouldMatter), async (posting) => {
      const detail = (
        await fetchJson(`${API}/${company.token}/jobs/${posting.externalId}`)
      ).data as RipDetail;

      posting.description = htmlToText(
        Object.values(detail.description ?? {}).join(" "),
      );
      if (detail.createdOn) posting.postedAt = new Date(detail.createdOn);
      if (detail.workLocations?.length) {
        posting.locations = [
          ...new Set([...posting.locations, ...detail.workLocations]),
        ];
      }
      if (detail.department?.base_department) {
        posting.department = detail.department.base_department;
      }
    });

    return {
      postings,
      etag: res.etag,
      lastModified: res.lastModified,
      notModified: false,
    };
  },
};

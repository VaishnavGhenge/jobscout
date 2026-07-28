import { NextResponse } from "next/server";
import { companies, type Company } from "@/lib/companies";
import { connectors } from "@/lib/connectors";
import { assessEligibility } from "@/lib/eligibility";
import { isEngineeringRole } from "@/lib/scoring";
import { profile } from "@/lib/profile";
import { parseRegions } from "@/lib/regions";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Region audit. Hits every board and reports where each company is *actually*
 * posting roles, so `hiresIn` in companies.ts can be re-checked against reality
 * instead of drifting into folklore. Touches no database.
 *
 * GET /api/audit  ->  per-company region counts + eligibility breakdown
 *
 * `homeRoles: 0` on a company you keep applying to is the finding to act on.
 */
async function auditCompany(company: Company) {
  try {
    // No conditional headers here: the audit needs the live board every time,
    // and a 304 would leave it with nothing to count.
    const { postings } = await connectors[company.ats].fetch(company);
    const eng = postings.filter((p) => isEngineeringRole(p.title));

    const regionCounts: Record<string, number> = {};
    const eligibilityCounts = { eligible: 0, longshot: 0, blocked: 0 };
    let homeRoles = 0;

    for (const p of eng) {
      for (const r of parseRegions([p.location, ...p.locations, p.countryCode])) {
        regionCounts[r] = (regionCounts[r] ?? 0) + 1;
        if (r === profile.basedIn) homeRoles += 1;
      }
      eligibilityCounts[assessEligibility(p, company).eligibility] += 1;
    }

    return {
      company: company.name,
      declaredHiresIn: company.hiresIn,
      engineeringRoles: eng.length,
      homeRoles,
      regions: Object.fromEntries(
        Object.entries(regionCounts).sort((a, b) => b[1] - a[1]),
      ),
      eligibility: eligibilityCounts,
      /** Set when the board contradicts what companies.ts claims. */
      warning:
        company.hiresIn.includes(profile.basedIn) && homeRoles === 0
          ? `declares it hires in ${profile.basedIn} but has no ${profile.basedIn} engineering roles right now`
          : undefined,
    };
  } catch (err) {
    return {
      company: company.name,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function GET() {
  const results = await Promise.all(companies.map(auditCompany));
  return NextResponse.json({
    basedIn: profile.basedIn,
    companies: results,
    warnings: results.filter((r) => "warning" in r && r.warning).map((r) => r.company),
  });
}

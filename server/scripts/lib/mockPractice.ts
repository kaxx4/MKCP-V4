/**
 * Make the practice-company check (#128) pass HONESTLY inside a mock-only run.
 *
 * Why this exists (rebuild task 0-3, 5-Nov-2026): with server/.env loaded, the
 * laptop's role is sandbox and MKCP_PRACTICE_COMPANY(_GUID) are set, so
 * tallyPost refuses any request whose company is not the practice one, and
 * checks that company's GUID in the company listing. The captured fixtures
 * predate #128: their listing carries no GUID. So every replayed request was
 * refused before it reached the mock, and the edge-case catalogue's G7 table
 * was a column of "rejected: refused: company ..." that measured nothing.
 *
 * The check stays ON. For this process only, the practice company becomes the
 * one the fixtures name, with a fake GUID, and the company listing the mock
 * answers carries that GUID. Nothing here can reach a socket: it only wraps a
 * transport that is already a mock.
 */
import type { installMock } from "../../src/services/tallyMock.js";
type Transport = Parameters<typeof installMock>[0];
import { resetListingCache } from "../../src/tally.js";

export const FIXTURE_GUID = "ZZ-FIXTURE-GUID-0000";

const companyOf = (xml: string) => /<SVCURRENTCOMPANY>([\s\S]*?)<\/SVCURRENTCOMPANY>/i.exec(xml)?.[1]?.trim() ?? "";
const isListing = (xml: string) => /<ID>\s*List of Companies\s*<\/ID>/i.test(xml);

/** Add the fake GUID to the named company's block in a company listing. */
function withGuid(listing: string, company: string): string {
  const esc = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return listing.replace(new RegExp(`(<COMPANY\\b[^>]*NAME="${esc}"[^>]*>)`, "i"), `$1<GUID>${FIXTURE_GUID}</GUID>`);
}

/**
 * Point the practice check at the fixtures' company for this process, and
 * return a wrapper that answers the company listing with the GUID added.
 * `requestXml` is any captured request that names the company.
 */
export function practiceForFixtures(requestXml: string, listingXml: string): { company: string; wrap: (t: Transport) => Transport } {
  const company = companyOf(requestXml);
  if (!company) throw new Error("practiceForFixtures: the sample request names no company");
  process.env.MKCP_PRACTICE_COMPANY = company;
  process.env.MKCP_PRACTICE_COMPANY_GUID = FIXTURE_GUID;
  resetListingCache();
  const listing = withGuid(listingXml, company);
  if (!listing.includes(FIXTURE_GUID)) throw new Error("practiceForFixtures: the listing fixture does not hold the company the requests name");
  const wrap = (t: Transport): Transport => async (url, xml, timeoutMs) => (isListing(xml) ? listing : t(url, xml, timeoutMs));
  return { company, wrap };
}

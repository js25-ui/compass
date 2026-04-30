// USPTO retrieval — currently stubbed.
//
// The free PatentsView REST API was sunset in 2024–2025; api.patentsview.org
// now redirects to a marketing page for the USPTO Open Data Portal. The
// replacement (developer.uspto.gov) doesn't expose an equivalent assignee
// search endpoint as of this writing — the available endpoints (PEDS, PTAB,
// trademark assignment) don't cover patent assignee text search.
//
// Options for re-enabling:
//   1. Implement the PEDS API client (XML, registration-free) — serviceable
//      but heavy.
//   2. Stand up a self-hosted patent index from the USPTO bulk weekly XML
//      files — lots of storage, big build cost.
//   3. Pay for a third-party API (Google Patents, Lens.org, IFI Claims).
//
// For now `searchPatentsByAssignee` returns an empty array. Ingest pipelines
// treat this as "no patent coverage available" and move on.

export interface Patent {
  patentNumber: string;
  patentTitle: string;
  patentDate: string;
  patentAbstract: string | null;
  assignee: string | null;
}

export async function searchPatentsByAssignee(
  _assignee: string,
  _opts: { perPage?: number } = {},
): Promise<Patent[]> {
  return [];
}

export const USPTO_AVAILABLE = false;

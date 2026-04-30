// FINRA TRACE corporate-bond trade history.
//
// Free public API at https://api.finra.org but requires registration for an
// OAuth token. Endpoints we'd consume:
//
//   POST /data/group/Firm/name/CorporateAndAgencyDebtDataset
//     → trade-by-trade data (CUSIP, price, yield, volume, execution time)
//     coverage: post-2002, near-real-time with 15-min lag
//
//   POST /data/group/Firm/name/SecuritizedProductTradeDataset
//     → MBS / ABS / CMBS trade history
//
// To enable: register at https://finra.org/finra-data, get OAuth credentials,
// set FINRA_API_KEY (and FINRA_API_SECRET if needed) in .env.local.
//
// Pre-2002 corporate bond pricing detail isn't covered by TRACE — that data
// only exists in paid feeds (Bloomberg, ICE Data, Markit). The chat layer
// should surface that limitation honestly.

export interface BondTrade {
  cusip: string;
  executionDate: string;     // ISO datetime
  price: number;             // % of par
  yield: number;
  volume: number;            // par value traded
  side: 'B' | 'S' | 'D';     // buy / sell / dealer-to-dealer
}

export const FINRA_TRACE_AVAILABLE = false;

export async function fetchBondTradeHistory(
  _cusip: string,
  _opts: { fromDate?: string; toDate?: string } = {},
): Promise<BondTrade[]> {
  if (!process.env.FINRA_API_KEY) return [];
  // TODO: implement OAuth token fetch + trade history query when key is provisioned.
  return [];
}

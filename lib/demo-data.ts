export type BusinessLine = 'ecm' | 'dcm' | 'alts';
export type Stage = 'research' | 'diligence' | 'model' | 'memo' | 'monitor' | 'action';
export type FlagColor = 'green' | 'yellow' | 'red';
export type FeedTag = 'PRICING' | 'FILING' | 'NEWS' | 'TRANSCRIPT' | 'REGULATORY';

export const businessLineNames: Record<BusinessLine, string> = {
  ecm: 'ECM',
  dcm: 'DCM',
  alts: 'Alternatives',
};

export const businessLineFull: Record<BusinessLine, string> = {
  ecm: 'Equity Capital Markets',
  dcm: 'Debt Capital Markets',
  alts: 'Alternative Investments',
};

export interface Subtag {
  id: string;
  name: string;
}

export const subtagsByBL: Record<BusinessLine, Subtag[]> = {
  ecm: [
    { id: 'ipos', name: 'IPOs' },
    { id: 'followons', name: 'Follow-Ons' },
    { id: 'secondaries', name: 'Secondaries' },
    { id: 'convertibles', name: 'Convertibles' },
  ],
  dcm: [
    { id: 'ig-corporate', name: 'IG Corporate' },
    { id: 'high-yield', name: 'High Yield' },
    { id: 'lev-loans', name: 'Leveraged Loans' },
    { id: 'municipal', name: 'Municipal' },
    { id: 'sovereign', name: 'Sovereign' },
    { id: 'securitized', name: 'Securitized' },
  ],
  alts: [
    { id: 'private-equity', name: 'Private Equity' },
    { id: 'real-estate', name: 'Real Estate' },
    { id: 'credit', name: 'Private Credit' },
    { id: 'infrastructure', name: 'Infrastructure' },
    { id: 'hedge', name: 'Hedge Funds' },
  ],
};

export interface FeedItem {
  tag: FeedTag;
  tagClass: 'pricing' | 'filing' | 'news' | 'transcript' | 'regulatory';
  title: string;
  snippet: string;
  source: string;
  date: string;
  type: string;
}

export const feedByBL: Record<BusinessLine, FeedItem[]> = {
  ecm: [
    { tag: 'PRICING', tagClass: 'pricing', title: 'Cava Group prices upsized IPO at $22, above $19-21 range', snippet: 'Mediterranean fast-casual prices 14.4M shares at $22, raising $317M.', source: 'Bloomberg', date: 'April 28, 2026', type: 'Deal Pricing' },
    { tag: 'FILING', tagClass: 'filing', title: 'Klaviyo files updated S-1 with 22% YoY revenue growth disclosure', snippet: 'Marketing automation platform discloses Q1 trailing revenue of $843M.', source: 'SEC EDGAR', date: 'April 26, 2026', type: 'Form S-1/A' },
    { tag: 'NEWS', tagClass: 'news', title: 'IPO market opens to highest issuance volume since Q3 2021', snippet: 'Renaissance Capital reports $14.2B raised across 38 deals YTD.', source: 'Renaissance Capital', date: 'April 27, 2026', type: 'Market Update' },
    { tag: 'TRANSCRIPT', tagClass: 'transcript', title: 'Birkenstock Q1 earnings: first call as public company exceeds estimates', snippet: 'Stock up 8% post-print. Provides positive read-through for upcoming consumer IPOs.', source: 'SEC 8-K', date: 'April 24, 2026', type: 'Earnings Call' },
  ],
  dcm: [
    { tag: 'PRICING', tagClass: 'pricing', title: 'Boeing prices $5B 30-year senior notes at T+165', snippet: 'Largest IG industrial bond of 2026. Coupon 6.10%.', source: 'Bloomberg', date: 'April 28, 2026', type: 'Bond Pricing' },
    { tag: 'NEWS', tagClass: 'news', title: 'IG corporate issuance hits $1.4T YTD, on pace for record year', snippet: 'Tech and pharma leading sectors.', source: 'Dealogic', date: 'April 27, 2026', type: 'Market Update' },
    { tag: 'PRICING', tagClass: 'pricing', title: 'NYC GO Bonds price $1.5B competitive sale, 4.42% TIC', snippet: 'AA1/AA/AA- rated 30Y. JPM wins competitive bid.', source: 'MSRB', date: 'April 28, 2026', type: 'Muni Pricing' },
    { tag: 'REGULATORY', tagClass: 'regulatory', title: 'Federal Reserve maintains rates at 4.25-4.50% range', snippet: 'FOMC holds steady. IG OAS tightens 4 bps post-decision.', source: 'Federal Reserve', date: 'April 30, 2026', type: 'FOMC' },
  ],
  alts: [
    { tag: 'NEWS', tagClass: 'news', title: 'Blackstone announces N1, new AI and high-growth tech division', snippet: 'New unit consolidates OpenAI, Anthropic, CoreWeave, and SpaceX exposure.', source: 'Bloomberg', date: 'April 29, 2026', type: 'News' },
    { tag: 'TRANSCRIPT', tagClass: 'transcript', title: 'Blackstone Q1 2026: 8 of top 10 best-performing investments are AI-infrastructure', snippet: 'Gray characterizes AI infrastructure as "the single biggest driver."', source: 'SEC 8-K', date: 'April 23, 2026', type: 'Earnings Call' },
    { tag: 'FILING', tagClass: 'filing', title: 'KKR files 10-Q showing $48B deployment in Q1', snippet: 'Largest quarter of capital deployment in firm history.', source: 'SEC EDGAR', date: 'April 25, 2026', type: 'Form 10-Q' },
    { tag: 'NEWS', tagClass: 'news', title: 'Apollo and Vista co-lead $4.2B take-private of vertical SaaS', snippet: 'Deal at 18x EBITDA reflects continued institutional appetite.', source: 'WSJ', date: 'April 26, 2026', type: 'Deal News' },
  ],
};

export interface Metric {
  label: string;
  value: string;
  trend: 'up' | 'down' | 'flat';
}

export const metricsByBL: Record<BusinessLine, Metric[]> = {
  ecm: [
    { label: 'IPO Pop Avg (YTD)', value: '+24%', trend: 'up' },
    { label: 'IPO Volume YTD', value: '$14.2B', trend: 'up' },
    { label: 'Avg P/S (Tech IPOs)', value: '8.2x', trend: 'flat' },
    { label: 'VIX', value: '17.4', trend: 'down' },
  ],
  dcm: [
    { label: 'IG OAS', value: '+92 bps', trend: 'down' },
    { label: '10Y UST Yield', value: '4.27%', trend: 'down' },
    { label: 'IG Volume YTD', value: '$1.42T', trend: 'up' },
    { label: 'HY Default Rate', value: '2.1%', trend: 'up' },
  ],
  alts: [
    { label: 'PE Dry Powder', value: '$1.42T', trend: 'flat' },
    { label: 'LBO Avg Multiple', value: '11.8x', trend: 'down' },
    { label: 'Deal Volume QoQ', value: '+12%', trend: 'up' },
    { label: 'Software Exit Multiples', value: '6.2x rev', trend: 'down' },
  ],
};

export const quickQByBL: Record<BusinessLine, string[]> = {
  ecm: ['Build IPO valuation model from S-1', 'Compare Cava to consumer IPO comps', 'Run aftermarket Monte Carlo'],
  dcm: ['Build bond pricing model', 'Compare Boeing 30Y to industrial comps', 'Run interest rate scenarios'],
  alts: ['Generate AI-disruption risk memo', 'Run LBO with Monte Carlo', 'Find vertical SaaS deals over $1B'],
};

export interface DiligenceItem {
  title: string;
  val: string;
  sub: string;
  flag: FlagColor;
}

export const dilByBL: Record<BusinessLine, DiligenceItem[]> = {
  ecm: [
    { title: 'Revenue Growth (3Y CAGR)', val: '38%', sub: 'Above peer median 22%', flag: 'green' },
    { title: 'Gross Margin', val: '24.6%', sub: 'In line with fast-casual peers', flag: 'green' },
    { title: 'Customer Concentration', val: 'Low', sub: 'No customer over 2% of revenue', flag: 'green' },
    { title: 'Founder Lockup', val: '180 days', sub: 'Standard, no early release triggers', flag: 'green' },
    { title: 'Litigation Risk', val: '2 items', sub: 'Routine wage/hour class action', flag: 'yellow' },
    { title: 'Use of Proceeds', val: 'Mixed', sub: '60% primary, 40% secondary to insiders', flag: 'yellow' },
  ],
  dcm: [
    { title: 'Total Debt', val: '$48.2B', sub: '5.4x net leverage post-issuance', flag: 'yellow' },
    { title: 'Interest Coverage', val: '6.2x', sub: 'EBITDA / interest expense', flag: 'green' },
    { title: 'Liquidity Position', val: '$14.1B', sub: 'Cash plus undrawn revolver', flag: 'green' },
    { title: 'Maturity Wall', val: '$8.2B', sub: '2027 maturities · refi planned', flag: 'yellow' },
    { title: 'Covenant Compliance', val: 'In Compliance', sub: 'All covenants met with cushion', flag: 'green' },
    { title: 'Sector Outlook', val: 'Stable', sub: "S&P, Moody's both affirmed", flag: 'green' },
  ],
  alts: [
    { title: 'Revenue Concentration', val: '38%', sub: 'Top 5 customers · declining trend', flag: 'yellow' },
    { title: 'Gross Margin', val: '71.2%', sub: '+340 bps over 3 years', flag: 'green' },
    { title: 'NRR', val: '114%', sub: 'Best-in-class for vertical SaaS', flag: 'green' },
    { title: 'AI-Disruption Risk', val: 'Medium', sub: 'Workflow defensibility moderate', flag: 'yellow' },
    { title: 'Working Capital', val: '3 flagged', sub: 'DSO trending up', flag: 'yellow' },
    { title: 'Legal/Regulatory', val: 'Clean', sub: 'No material litigation', flag: 'green' },
  ],
};

export const modelTabsByBL: Record<BusinessLine, string[]> = {
  ecm: ['Valuation Comps', 'DCF', 'IPO Pricing', 'Aftermarket', 'Monte Carlo'],
  dcm: ['Yield Curve', 'Credit Model', 'Spread Comps', 'Cash Flow', 'Monte Carlo'],
  alts: ['LBO Returns', '3-Statement', 'DCF', 'Sensitivity', 'Monte Carlo'],
};

export interface MonteCarloProb {
  val: string;
  label: string;
  cls: 'good' | 'warn' | 'bad';
}

export interface PercentileRow {
  l: string;
  v: string;
  cls?: 'median';
}

export interface MonteCarloConfig {
  probs: MonteCarloProb[];
  chartTitle: string;
  pctTitle: string;
  pcts: PercentileRow[];
  min: number;
  max: number;
  median: number;
  stdev: number;
  hurdle: number;
  hurdleLabel: string;
}

export const mcByBL: Record<BusinessLine, MonteCarloConfig> = {
  ecm: {
    probs: [
      { val: '82%', label: 'P(Day-1 Close > Issue)', cls: 'good' },
      { val: '24%', label: 'P(Day-1 Pop > 50%)', cls: 'warn' },
      { val: '7%', label: 'P(Day-1 Decline)', cls: 'bad' },
    ],
    chartTitle: 'Day-1 Return Distribution · 10,000 Simulated Outcomes',
    pctTitle: 'Percentile Outcomes (Day-1 Return)',
    pcts: [
      { l: 'P95', v: '+72%' },
      { l: 'P75', v: '+45%' },
      { l: 'P50 (Median)', v: '+28%', cls: 'median' },
      { l: 'P25', v: '+12%' },
      { l: 'P5', v: '−8%' },
    ],
    min: -20,
    max: 80,
    median: 28,
    stdev: 18,
    hurdle: 0,
    hurdleLabel: 'Issue Price',
  },
  dcm: {
    probs: [
      { val: '95%', label: 'P(Full Coverage 30Y)', cls: 'good' },
      { val: '12%', label: 'P(Spread Widens >50bps)', cls: 'warn' },
      { val: '0.4%', label: 'P(Default in 10Y)', cls: 'bad' },
    ],
    chartTitle: 'Total Return Distribution · 10,000 Trials over 30Y',
    pctTitle: 'Percentile Outcomes (Annualized Return)',
    pcts: [
      { l: 'P95', v: '7.4%' },
      { l: 'P75', v: '6.6%' },
      { l: 'P50', v: '6.10%', cls: 'median' },
      { l: 'P25', v: '5.4%' },
      { l: 'P5', v: '3.8%' },
    ],
    min: 2,
    max: 8,
    median: 6.1,
    stdev: 0.8,
    hurdle: 5,
    hurdleLabel: '5% Floor',
  },
  alts: {
    probs: [
      { val: '82.3%', label: 'P(IRR > 15% Hurdle)', cls: 'good' },
      { val: '61.4%', label: 'P(MOIC > 2.5x)', cls: 'warn' },
      { val: '4.2%', label: 'P(Capital Loss)', cls: 'bad' },
    ],
    chartTitle: 'IRR Distribution · 10,000 Simulated Outcomes',
    pctTitle: 'Percentile Outcomes (IRR)',
    pcts: [
      { l: 'P95', v: '37.4%' },
      { l: 'P75', v: '28.1%' },
      { l: 'P50 (Median)', v: '22.0%', cls: 'median' },
      { l: 'P25', v: '15.8%' },
      { l: 'P5', v: '4.2%' },
    ],
    min: -5,
    max: 45,
    median: 22,
    stdev: 9,
    hurdle: 15,
    hurdleLabel: '15% Hurdle',
  },
};

export interface Memo {
  title: string;
  content: string;
}

export const memoByBL: Record<BusinessLine, Memo> = {
  ecm: {
    title: 'IPO Pricing Memo · Cava Group',
    content: '<h2>Recommendation</h2><p>We recommend pricing the Cava Group IPO at <strong>$22 per share</strong>, the upper end of the marketed $19-21 range, raising approximately $317M.</p>',
  },
  dcm: {
    title: 'New Issue Memo · Boeing 30Y Senior Notes',
    content: '<h2>Recommendation</h2><p>We recommend pricing $5.0B Boeing 30-year senior unsecured notes at <strong>T+165</strong> (6.10% coupon).</p>',
  },
  alts: {
    title: 'Investment Committee Memo · Project Compass',
    content: '<h2>Executive Summary</h2><p>We recommend the Investment Committee approve a $520M equity investment.</p>',
  },
};

export interface KPI {
  label: string;
  value: string;
  change: string;
}

export interface Alert {
  type: FlagColor;
  title: string;
  msg: string;
}

export interface MonitorData {
  kpis: KPI[];
  alerts: Alert[];
}

export const monitorByBL: Record<BusinessLine, MonitorData> = {
  ecm: {
    kpis: [
      { label: 'Issue Price', value: '$22.00', change: 'Day-1 close' },
      { label: 'Day 1 Pop', value: '+34%', change: 'up' },
      { label: 'TTM Performance', value: '+18%', change: 'up' },
      { label: 'Avg Daily Volume', value: '4.2M sh', change: '' },
    ],
    alerts: [
      { type: 'green', title: 'Strong aftermarket performance', msg: 'Stock has held above issue price for all 28 trading days post-IPO.' },
      { type: 'yellow', title: 'Lockup expiration approaching', msg: '180-day lockup expires October 25, 2026.' },
    ],
  },
  dcm: {
    kpis: [
      { label: 'Issue Yield', value: '6.10%', change: 'At pricing' },
      { label: 'Current Yield', value: '5.92%', change: 'down' },
      { label: 'Spread Change', value: '−18 bps', change: 'up' },
      { label: 'Bid/Ask', value: '0.125', change: '' },
    ],
    alerts: [
      { type: 'green', title: 'Performance ahead of curve', msg: 'Tightened 18 bps since issue.' },
      { type: 'yellow', title: 'Covenant headroom monitoring', msg: 'Pro forma for proposed add-on financing.' },
    ],
  },
  alts: {
    kpis: [
      { label: 'Revenue (TTM)', value: '$418M', change: '+15.4% vs plan' },
      { label: 'EBITDA Margin', value: '34.6%', change: '+160 bps YoY' },
      { label: 'Net Leverage', value: '5.4x', change: '−0.5x QoQ' },
      { label: 'NRR', value: '112%', change: '−2 pp QoQ' },
    ],
    alerts: [
      { type: 'yellow', title: 'NRR softness detected', msg: 'Net Revenue Retention dropped 200 bps QoQ.' },
      { type: 'red', title: 'Covenant headroom narrowing', msg: 'Total Net Leverage covenant set at 6.5x.' },
    ],
  },
};

export interface ActionTarget {
  label: string;
  value: string;
}

export interface ActionData {
  action: string;
  actionClass: 'buy';
  summary: string;
  thesis: string[];
  targets: ActionTarget[];
}

export const actionByBL: Record<BusinessLine, ActionData> = {
  ecm: {
    action: 'PRICE AT TOP',
    actionClass: 'buy',
    summary: 'Recommend pricing Cava IPO at $22, top of $19-21 range. 17.7x book oversubscription justifies aggressive pricing.',
    thesis: [
      'Demand book of $5.6B against $317M offered (17.7x cover) supports max-end pricing.',
      'Comparable consumer IPO performance YTD suggests constructive aftermarket window.',
      'Order book quality is exceptional with 64% of demand from top 50 accounts.',
      'Lockup at 180 days protects against early supply pressure.',
    ],
    targets: [
      { label: 'Pricing', value: '$22.00' },
      { label: 'Implied EV', value: '$2.4B' },
      { label: 'Day 1 Target', value: '+25-35%' },
      { label: 'Conviction', value: 'High' },
    ],
  },
  dcm: {
    action: 'PRICE AT T+165',
    actionClass: 'buy',
    summary: 'Recommend pricing Boeing 30Y senior notes at T+165 / 6.10% coupon.',
    thesis: [
      'Order book of $19.4B vs $5B issuance signals strong placement.',
      'New-issue concession of 5 bps aligned with recent IG industrial precedent.',
      'Both rating agencies affirmed in March 2026.',
      'IG fund flows of +$48B YTD provide technical tailwind.',
    ],
    targets: [
      { label: 'Spread', value: 'T+165' },
      { label: 'Coupon', value: '6.10%' },
      { label: 'Issue Size', value: '$5.0B' },
      { label: 'Conviction', value: 'High' },
    ],
  },
  alts: {
    action: 'APPROVE INVESTMENT',
    actionClass: 'buy',
    summary: 'Recommend approval of $520M equity investment in Project Compass.',
    thesis: [
      'Mission-critical vertical SaaS with 96.4% logo retention.',
      'Best-in-class unit economics with clear margin expansion path.',
      '$14B underpenetrated TAM.',
      'AI-disruption risk rated Yellow/Medium with mitigation plan.',
    ],
    targets: [
      { label: 'Equity Check', value: '$520M' },
      { label: 'Total EV', value: '$1.29B' },
      { label: 'Base IRR', value: '22.2%' },
      { label: 'P(Beat Hurdle)', value: '82.3%' },
    ],
  },
};

export interface DemoTarget {
  id: string;
  bl: BusinessLine;
  title: string;
  ticker?: string;
}

export const demoTargets: DemoTarget[] = [
  { id: 'cava-ipo-2026', bl: 'ecm', title: 'Cava Group IPO', ticker: 'CAVA' },
  { id: 'ba-30y-2056', bl: 'dcm', title: 'Boeing 30Y Senior Notes', ticker: 'BA' },
  { id: 'nyc-go-2026', bl: 'dcm', title: 'NYC GO Bonds', ticker: 'NYC' },
  { id: 'blackstone-pe-2026', bl: 'alts', title: 'Blackstone PE', ticker: 'BX' },
  { id: 'prologis-2026', bl: 'alts', title: 'Prologis', ticker: 'PLD' },
];

export const recentResearch: Array<{ ticker: string; title: string; targetId: string; bl: BusinessLine }> = [
  { ticker: 'CAVA', title: 'Cava IPO', targetId: 'cava-ipo-2026', bl: 'ecm' },
  { ticker: 'BA', title: 'Boeing 30Y Notes', targetId: 'ba-30y-2056', bl: 'dcm' },
  { ticker: 'NYC', title: 'NYC GO Bonds', targetId: 'nyc-go-2026', bl: 'dcm' },
];

export interface CitationSource {
  n: number;
  title: string;
  meta: string;
}

export interface SampleAnswer {
  user: string;
  activity: string[];
  answer: string;
  sources: CitationSource[];
  latencyMs: number;
}

export const sampleAnswers: Record<'cava' | 'boeing' | 'blackstone', SampleAnswer> = {
  cava: {
    user: 'Should we price Cava IPO at $22 or the midpoint?',
    activity: [
      'Filings Agent · queried Cava S-1 and 4 amendments',
      'Comps Agent · pulled 14 IPO comps from past 18 months',
      'Model Agent · accessed Monte Carlo run #3 outputs',
      'Synthesizing answer · 4 sources cited · 4.2s total',
    ],
    latencyMs: 4200,
    answer: `<p>Two factors drove the recommendation to price at $22 (top of the $19-21 range) rather than the midpoint:</p>
<p><strong>Demand book strength.</strong> Order book of $5.6B against $317M offered represents 17.7x oversubscription, with top 50 accounts holding 64% of demand<a class="chat-citation">1</a>. Recent precedent on similarly-oversubscribed consumer IPOs shows tight allocation at the top of range outperforms midpoint pricing in aftermarket performance<a class="chat-citation">2</a>.</p>
<p><strong>Comp valuation supports it.</strong> Cava's 38% revenue CAGR and 24.6% gross margin places it at $22 in a 4.8x EV/Revenue range that's still 12% below median consumer IPO multiples for the cohort<a class="chat-citation">3</a>. There's room to run.</p>
<p>On Day 1 expectations: 10,000-trial Monte Carlo distribution suggests median +28% pop with 82% probability of positive close and 24% probability of >50% pop. P5 worst case is −8%<a class="chat-citation">4</a>. <strong>Confidence: high but not heroic.</strong></p>`,
    sources: [
      { n: 1, title: 'Demand Book Allocation Memo', meta: 'Bookrunner Roadshow Notes · April 27, 2026 · Page 3' },
      { n: 2, title: 'IPO Aftermarket Analysis: Top-of-Range vs Midpoint', meta: 'Renaissance Capital · April 2026 · Section 4' },
      { n: 3, title: 'Cava Group S-1 Filing, Comparable Companies Analysis', meta: 'SEC EDGAR · April 18, 2026 · Pages 142-148' },
      { n: 4, title: 'Monte Carlo Output: Cava Day-1 Return Distribution', meta: 'Compass Model · 10,000 trials · Seed 42' },
    ],
  },
  boeing: {
    user: 'Where should Boeing 30Y senior notes price?',
    activity: [
      'Filings Agent · queried Boeing 10-K, 10-Q, recent indentures',
      'Comps Agent · retrieved 22 IG industrial 30Y comps',
      'Macro Agent · pulled current Treasury curve and IG OAS',
      'Model Agent · ran credit pricing model with Monte Carlo',
      'Synthesizing · 5 sources cited · 6.1s total',
    ],
    latencyMs: 6100,
    answer: `<p>Recommended pricing: <strong>T+165 / 6.10% coupon</strong>, the tight end of T+170-175 initial price talk. Three supporting factors:</p>
<p><strong>Order book is strong.</strong> $19.4B against $5B offered (3.9x cover) signals demand absorbs tightening<a class="chat-citation">1</a>. 71% of demand from insurance and pension validates duration appetite, the buyer base most willing to hold to maturity<a class="chat-citation">2</a>.</p>
<p><strong>New-issue concession is appropriate.</strong> Boeing existing 30Y curve trades T+170; pricing 5 bps inside reflects a fair concession given improved credit narrative around 737 MAX production ramp<a class="chat-citation">3</a>. Industrial comps (Caterpillar, Deere, GE) trade T+125-145; the 25-40 bps premium captures Boeing's ratings position (BBB-/Baa3).</p>
<p><strong>Technicals support tightening.</strong> IG fund flows of +$48B YTD, IG OAS at +92 bps (down 4 bps post-FOMC), and 30Y supply absorbed even at peak issuance volumes<a class="chat-citation">4</a>. Monte Carlo across rate scenarios shows 95% probability of full debt service over 30Y horizon<a class="chat-citation">5</a>.</p>`,
    sources: [
      { n: 1, title: 'Boeing 30Y Order Book Summary', meta: 'Bookrunner Roadshow · April 28, 2026' },
      { n: 2, title: 'IG Demand Composition by Investor Type', meta: 'Bloomberg ICE BofA Index Data · Q1 2026' },
      { n: 3, title: 'Boeing 10-Q Q1 2026 · 737 MAX Production Update', meta: 'SEC EDGAR · Filed April 23, 2026' },
      { n: 4, title: 'Federal Reserve FOMC Statement', meta: 'April 30, 2026 · IG OAS Impact Analysis' },
      { n: 5, title: 'Boeing 30Y Total Return Monte Carlo', meta: 'Compass Model · 10,000 trials · Seed 42' },
    ],
  },
  blackstone: {
    user: "What is Blackstone's AI strategy in 2026?",
    activity: [
      'Filings Agent · pulled Blackstone 10-K, 10-Q, and Q1 earnings transcript',
      'News Agent · retrieved 47 articles from last 90 days',
      'Comps Agent · cross-referenced KKR, Apollo, Carlyle AI strategies',
      'Synthesizing · 6 sources cited · 5.4s total',
    ],
    latencyMs: 5400,
    answer: `<p>Blackstone has positioned itself as <strong>the largest investor in AI-related infrastructure in the world</strong>, per Schwarzman's Q1 2026 earnings remarks<a class="chat-citation">1</a>. The strategy operates across three vectors:</p>
<p><strong>Direct AI infrastructure investment.</strong> $150B in operational data centers plus $160B in pipeline. Eight of the top 10 best-performing investments in Q1 2026 were AI infrastructure related<a class="chat-citation">2</a>. Notable bets include CoreWeave ($7.5B + $2.3B debt), Anthropic ($200M in Series G), DDN ($300M), and Neysa (up to $1.2B).</p>
<p><strong>Organizational consolidation.</strong> On April 29, 2026, Blackstone launched <strong>Blackstone N1</strong>, a new division under SMD Jas Khaira consolidating OpenAI, Anthropic, CoreWeave, and SpaceX exposure into a single West Coast unit<a class="chat-citation">3</a>.</p>
<p><strong>Portfolio AI-disruption mandate.</strong> Per Jon Gray, every IC memo (equity AND debt) now includes an AI-disruption risk paragraph in the first two pages with a traffic-light scoring system. Software exposure (under 7% of AUM) is the sector most flagged at risk<a class="chat-citation">4</a>. Operating Team under Rodney Zemmel (ex-McKinsey, hired Feb 2026) leads portfolio AI integration with a "two-year window" thesis<a class="chat-citation">5</a>.</p>
<p>Internal tools include DocAI and Secure Chat (Azure OpenAI + AWS Bedrock abstraction), with $200M EBITDA portfolio impact already booked from AI-driven productivity initiatives<a class="chat-citation">6</a>.</p>`,
    sources: [
      { n: 1, title: 'Blackstone Q1 2026 Earnings Call Transcript', meta: 'SEC 8-K · April 23, 2026 · Schwarzman remarks' },
      { n: 2, title: 'Blackstone Q1 2026 10-Q · Investment Performance', meta: 'SEC EDGAR · April 23, 2026 · Pages 28-34' },
      { n: 3, title: 'Blackstone N1 Division Launch', meta: 'Bloomberg · April 29, 2026' },
      { n: 4, title: 'Jon Gray, 2025 CIO Symposium · AI Disruption Framework', meta: 'Conference transcript · December 2025' },
      { n: 5, title: 'Rodney Zemmel Hire Announcement and Mandate', meta: 'Blackstone Press Release · February 2026' },
      { n: 6, title: 'Internal AI Tools and Portfolio Impact', meta: 'Q1 2026 Investor Presentation · Page 18' },
    ],
  },
};

export function pickAnswer(question: string): SampleAnswer {
  const q = question.toLowerCase();
  if (q.includes('cava')) return sampleAnswers.cava;
  if (q.includes('boeing')) return sampleAnswers.boeing;
  if (q.includes('blackstone')) return sampleAnswers.blackstone;
  return sampleAnswers.cava;
}

export function findTargetId(title: string, bl: BusinessLine): string {
  const match = demoTargets.find(t => t.bl === bl && title.toLowerCase().includes(t.title.toLowerCase().split(' ')[0]));
  return match?.id ?? demoTargets.find(t => t.bl === bl)!.id;
}

export function getTarget(id: string): DemoTarget | undefined {
  return demoTargets.find(t => t.id === id);
}

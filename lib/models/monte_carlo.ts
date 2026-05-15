/**
 * Monte Carlo overlay. Runs an underlying pure model N times with sampled
 * inputs and returns outcome statistics.
 *
 * Generic over the underlying model — caller supplies (a) the base inputs,
 * (b) which input fields are stochastic + their distribution, (c) a model
 * function that maps inputs -> outcome scalar. Mulberry32 PRNG for
 * reproducibility under a fixed seed.
 */

export type DistributionSpec =
  | { kind: 'normal'; mean: number; stdev: number }
  | { kind: 'uniform'; min: number; max: number }
  | { kind: 'triangular'; min: number; mode: number; max: number }
  | { kind: 'fixed'; value: number };

export interface MonteCarloRequest<Inputs extends Record<string, number>> {
  baseInputs: Inputs;
  /** Subset of base-input keys to vary. Each gets a distribution. */
  stochastic: Partial<Record<keyof Inputs, DistributionSpec>>;
  /** Pure model. Throw to indicate an infeasible sample (skipped). */
  modelFn: (inputs: Inputs) => number | null;
  trials: number;
  seed: number;
  /** Optional hurdle for probability-of-beating-hurdle. */
  hurdle?: number;
}

export interface MonteCarloResult {
  trials: number;
  validTrials: number;
  failedTrials: number;
  seed: number;
  /** All valid outcome values, sorted ascending. */
  outcomes: number[];
  mean: number;
  stdev: number;
  percentiles: { p5: number; p25: number; p50: number; p75: number; p95: number };
  probAboveHurdle: number | null;
  hurdle: number | null;
  /** Histogram with bin counts and edges, for rendering. */
  histogram: { binEdges: number[]; binCounts: number[] };
  /** First 8 (inputs, outcome) pairs for the Work-tab "sample trials" panel. */
  sampleTrials: Array<{ inputs: Record<string, number>; outcome: number | null }>;
}

/** Mulberry32 — fast, well-distributed, 32-bit-seed PRNG. Deterministic. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller normal sample using two uniform draws from the rng. */
function sampleNormal(rng: () => number, mean: number, stdev: number): number {
  // Avoid log(0) by clamping the first uniform.
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stdev;
}

function sampleUniform(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

function sampleTriangular(rng: () => number, min: number, mode: number, max: number): number {
  const u = rng();
  const f = (mode - min) / (max - min);
  if (u < f) return min + Math.sqrt(u * (max - min) * (mode - min));
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

function sampleFrom(rng: () => number, spec: DistributionSpec): number {
  switch (spec.kind) {
    case 'normal':     return sampleNormal(rng, spec.mean, spec.stdev);
    case 'uniform':    return sampleUniform(rng, spec.min, spec.max);
    case 'triangular': return sampleTriangular(rng, spec.min, spec.mode, spec.max);
    case 'fixed':      return spec.value;
  }
}

export function runMonteCarlo<Inputs extends Record<string, number>>(
  req: MonteCarloRequest<Inputs>,
): MonteCarloResult {
  if (req.trials < 1) throw new Error(`Monte Carlo trials must be ≥1 (got ${req.trials}).`);
  const rng = mulberry32(req.seed);

  const outcomes: number[] = [];
  const sampleTrials: MonteCarloResult['sampleTrials'] = [];
  let failed = 0;

  const stochasticKeys = Object.keys(req.stochastic) as Array<keyof Inputs>;

  for (let i = 0; i < req.trials; i++) {
    const trialInputs = { ...req.baseInputs } as Inputs;
    for (const k of stochasticKeys) {
      const spec = req.stochastic[k];
      if (!spec) continue;
      (trialInputs as Record<string, number>)[k as string] = sampleFrom(rng, spec);
    }
    let outcome: number | null = null;
    try {
      outcome = req.modelFn(trialInputs);
    } catch {
      outcome = null;
    }
    if (outcome != null && Number.isFinite(outcome)) {
      outcomes.push(outcome);
    } else {
      failed += 1;
    }
    if (sampleTrials.length < 8) {
      const shown: Record<string, number> = {};
      for (const k of stochasticKeys) shown[k as string] = trialInputs[k] as unknown as number;
      sampleTrials.push({ inputs: shown, outcome });
    }
  }

  if (outcomes.length === 0) {
    throw new Error(`Monte Carlo: all ${req.trials} trials produced invalid outcomes — no statistics to compute.`);
  }

  outcomes.sort((a, b) => a - b);
  const mean = outcomes.reduce((s, x) => s + x, 0) / outcomes.length;
  const variance = outcomes.reduce((s, x) => s + (x - mean) ** 2, 0) / outcomes.length;
  const stdev = Math.sqrt(variance);

  const percentile = (p: number): number => {
    const idx = (outcomes.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return outcomes[lo];
    const w = idx - lo;
    return outcomes[lo] * (1 - w) + outcomes[hi] * w;
  };
  const percentiles = {
    p5: percentile(0.05),
    p25: percentile(0.25),
    p50: percentile(0.50),
    p75: percentile(0.75),
    p95: percentile(0.95),
  };

  let probAboveHurdle: number | null = null;
  if (req.hurdle != null && Number.isFinite(req.hurdle)) {
    const above = outcomes.filter(x => x >= req.hurdle!).length;
    probAboveHurdle = above / outcomes.length;
  }

  // 25 bins between min and max.
  const numBins = 25;
  const lo = outcomes[0];
  const hi = outcomes[outcomes.length - 1];
  const binWidth = (hi - lo) / numBins || 1;
  const binEdges: number[] = [];
  const binCounts: number[] = new Array(numBins).fill(0);
  for (let i = 0; i <= numBins; i++) binEdges.push(lo + i * binWidth);
  for (const x of outcomes) {
    let idx = Math.floor((x - lo) / binWidth);
    if (idx >= numBins) idx = numBins - 1;
    if (idx < 0) idx = 0;
    binCounts[idx] += 1;
  }

  return {
    trials: req.trials,
    validTrials: outcomes.length,
    failedTrials: failed,
    seed: req.seed,
    outcomes,
    mean,
    stdev,
    percentiles,
    probAboveHurdle,
    hurdle: req.hurdle ?? null,
    histogram: { binEdges, binCounts },
    sampleTrials,
  };
}

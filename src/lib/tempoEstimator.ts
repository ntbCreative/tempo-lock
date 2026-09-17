import type { TempoCandidate, TempoEstimate } from './types';

/**
 * Tempo estimation from a list of onset times (seconds).
 *
 * Method: build inter-onset intervals (IOIs) between nearby onsets (not just
 * adjacent pairs, so we also see 2-beat/3-beat spans), map each IOI and its
 * simple integer harmonics/sub-harmonics (1/3, 1/2, 1, 2, 3) into candidate
 * BPMs, and cluster those votes by absolute millisecond distance rather than
 * percentage distance. Millisecond tolerance matters because a fixed
 * *percentage* window is wider in absolute terms at slow tempos and narrower
 * at fast tempos, which is exactly backwards from what's needed to stop fast
 * tempos being swallowed into their half-time neighbour.
 *
 * The direct (span=1, harmonic=1) interval is real and gets full weight, but
 * so do the natural multiples that a genuinely periodic signal also
 * produces (e.g. a train at 180 BPM also has real 90 BPM and 60 BPM
 * periodicity). Summing support across spans naturally favours the
 * fundamental over its octaves without hard-coding a "prefer slower"
 * (or "prefer faster") rule, because the fundamental accumulates votes from
 * every span while an octave only accumulates from a subset.
 *
 * Confidence is deliberately based on the winning candidate's *absolute*
 * vote count (support), not its *share* of the total vote weight across
 * all harmonic candidates. A share-based confidence is miscalibrated: a
 * very clean, consistent source (e.g. a metronome-steady stick tap) also
 * populates its half/double/third-time siblings cleanly, so the winner's
 * share doesn't reliably rise with more consistent evidence -- it can
 * even fall as those siblings accumulate their own votes in parallel. An
 * absolute, saturating measure of the winner's own support grows
 * monotonically with real evidence instead, whether or not competing
 * harmonics also happen to be well-supported.
 */

export interface TempoEstimatorConfig {
  minBpm: number;
  maxBpm: number;
  /** Clustering tolerance in *milliseconds* of implied beat interval, not a percentage. */
  msTolerance: number;
  minOnsetsToAccept: number;
  /** How many onsets ahead of each onset to pair up when building intervals. */
  maxSpan: number;
  /** Relative score gap below which two top candidates are considered "similar" for tie-breaking. */
  tieBreakEpsilon: number;
  /** Winning candidate's raw vote count at/above which confidence reaches 1.0. */
  supportSaturation: number;
}

export const DEFAULT_ESTIMATOR_CONFIG: TempoEstimatorConfig = {
  minBpm: 40,
  maxBpm: 240,
  msTolerance: 35,
  minOnsetsToAccept: 4,
  maxSpan: 3,
  tieBreakEpsilon: 0.08,
  supportSaturation: 12,
};

function bpmToIntervalMs(bpm: number): number {
  return 60000 / bpm;
}

function intervalMsToBpm(ms: number): number {
  return 60000 / ms;
}

const HARMONICS: { mult: number; weight: number }[] = [
  { mult: 1, weight: 1.0 },
  { mult: 2, weight: 0.7 },
  { mult: 0.5, weight: 0.7 },
  { mult: 3, weight: 0.4 },
  { mult: 1 / 3, weight: 0.4 },
];

/**
 * Estimate tempo from onset times. `priorBpm`, if given (typically the
 * currently displayed/locked tempo), is used only to break genuine near-ties
 * between two similarly-scored candidates -- it never overrides a clear
 * winner.
 */
export function estimateTempo(
  onsetTimesSec: number[],
  config: Partial<TempoEstimatorConfig> = {},
  priorBpm?: number | null
): TempoEstimate {
  const cfg = { ...DEFAULT_ESTIMATOR_CONFIG, ...config };
  const onsets = [...onsetTimesSec].sort((a, b) => a - b);

  if (onsets.length < cfg.minOnsetsToAccept) {
    return { bpm: null, confidence: 0, onsetCount: onsets.length, coherent: false, candidates: [] };
  }

  const iois: number[] = [];
  for (let i = 0; i < onsets.length; i++) {
    for (let span = 1; span <= cfg.maxSpan; span++) {
      const j = i + span;
      if (j < onsets.length) {
        const gap = onsets[j] - onsets[i];
        if (gap > 0) iois.push(gap);
      }
    }
  }

  if (iois.length === 0) {
    return { bpm: null, confidence: 0, onsetCount: onsets.length, coherent: false, candidates: [] };
  }

  const votes: { bpm: number; weight: number }[] = [];
  for (const ioiSec of iois) {
    const ioiMs = ioiSec * 1000;
    const fundamentalBpm = intervalMsToBpm(ioiMs);
    for (const { mult, weight } of HARMONICS) {
      const bpm = fundamentalBpm * mult;
      if (bpm >= cfg.minBpm && bpm <= cfg.maxBpm) {
        votes.push({ bpm, weight });
      }
    }
  }

  if (votes.length === 0) {
    return { bpm: null, confidence: 0, onsetCount: onsets.length, coherent: false, candidates: [] };
  }

  votes.sort((a, b) => a.bpm - b.bpm);

  const clusters: { bpmSum: number; count: number; weight: number }[] = [];
  for (const v of votes) {
    const intervalMs = bpmToIntervalMs(v.bpm);
    let placed = false;
    for (const cluster of clusters) {
      const clusterBpm = cluster.bpmSum / cluster.count;
      const clusterIntervalMs = bpmToIntervalMs(clusterBpm);
      if (Math.abs(intervalMs - clusterIntervalMs) <= cfg.msTolerance) {
        cluster.bpmSum += v.bpm;
        cluster.count += 1;
        cluster.weight += v.weight;
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push({ bpmSum: v.bpm, count: 1, weight: v.weight });
    }
  }

  const totalWeight = clusters.reduce((sum, c) => sum + c.weight, 0);
  const candidates: TempoCandidate[] = clusters
    .map((c) => ({
      bpm: c.bpmSum / c.count,
      score: totalWeight > 0 ? c.weight / totalWeight : 0,
      supportCount: c.count,
    }))
    .sort((a, b) => b.score - a.score);

  const top = candidates[0];
  const second = candidates[1];
  let chosen = top;

  if (second) {
    const scoreDiff = Math.abs(top.score - second.score);
    const ratio = top.bpm > second.bpm ? top.bpm / second.bpm : second.bpm / top.bpm;
    const isHalfOrDoubleRelation = Math.abs(ratio - 2) < 0.15;
    const isSimilarScore = scoreDiff <= cfg.tieBreakEpsilon;

    if (isSimilarScore && isHalfOrDoubleRelation) {
      // Genuine near-tie between a tempo and its octave: never default to
      // "always pick the slower one". Prefer whichever is closer to the
      // currently displayed tempo (continuity), then whichever has more
      // direct support, and only as a last resort default to the faster one.
      if (priorBpm != null && priorBpm > 0) {
        const topDiff = Math.abs(top.bpm - priorBpm);
        const secondDiff = Math.abs(second.bpm - priorBpm);
        chosen = topDiff <= secondDiff ? top : second;
      } else if (top.supportCount !== second.supportCount) {
        chosen = top.supportCount >= second.supportCount ? top : second;
      } else {
        chosen = top.bpm >= second.bpm ? top : second;
      }
    }
  }

  const confidence = Math.max(0, Math.min(1, chosen.supportCount / cfg.supportSaturation));
  // A basic sanity floor, not the real gate: real acceptance is the (now
  // support-based) confidence threshold applied upstream in continuity.ts.
  // This just rules out a degenerate zero/near-zero-support "winner".
  const coherent = chosen.supportCount >= 2;

  return {
    bpm: chosen.bpm,
    confidence,
    onsetCount: onsets.length,
    coherent,
    candidates,
  };
}

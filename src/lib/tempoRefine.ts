/**
 * Tempo refinement by beat-grid regression.
 *
 * The interval-clustering estimator (tempoEstimator.ts) is good at the
 * *coarse* question -- roughly what tempo, and which octave -- but its
 * number is a mean of single-gap votes, and every single gap carries the
 * onset detector's timing jitter (+/-10ms on a 500ms beat is +/-2 BPM).
 * That mean also shifts as onsets slide in and out of the analysis window,
 * which shows up on screen as a readout that wanders.
 *
 * The precise way to measure a steady tempo is to stop looking at gaps and
 * fit a line through the onset *times* against their beat number:
 *
 *     t_n = t_0 + n * period
 *
 * The slope is the period. Every onset in the window contributes, and the
 * long baseline means jitter that would be +/-2 BPM on one gap averages down
 * to a small fraction of a BPM: with N evenly spaced beats, period error
 * falls roughly as 1/N^1.5, versus 1/sqrt(N) for averaging independent gaps.
 *
 * Getting the beat numbers right is the hard part. Onsets that aren't on the
 * beat (ghost notes, subdivisions, handling noise) must be rejected, and a
 * stray onset at the very start must not become the reference. So:
 *
 *  - Walk the onsets in time order, assigning each the nearest beat number
 *    under the *current* period, and accept it only if it lands close to
 *    that beat's predicted time.
 *  - After every accepted onset, refit the line, so the period sharpens as
 *    the baseline grows (a phase-locked-loop style tracker). That's what
 *    lets a coarse starting tempo that's a few percent off still lock: two
 *    accepted points already correct it.
 *  - Try several early onsets as the anchor and keep the fit that explains
 *    the most onsets, so a leading stray doesn't ruin the grid.
 *
 * Returns null whenever the fit isn't trustworthy, and the caller falls back
 * to the coarse estimate. It refines an already-chosen tempo; it never picks
 * the octave, so it can't turn a right answer into a different wrong one.
 */

export interface RefineConfig {
  /** An onset is "on the grid" if within this fraction of the beat period of a predicted beat time... */
  toleranceFraction: number;
  /** ...clamped to at least this many seconds... */
  minToleranceSec: number;
  /** ...and at most this many. */
  maxToleranceSec: number;
  /** How many of the earliest onsets to try as the grid's anchor point. */
  maxAnchors: number;
  /** Minimum onsets that must land on the grid for the fit to be trusted. */
  minAcceptedBeats: number;
  /** Minimum span (in beats) between first and last accepted onset -- a fit over a short baseline isn't better than the coarse estimate. */
  minSpanBeats: number;
  /** The fitted period must stay within this fraction of the coarse period, or it's treated as a bad fit (e.g. locked onto a subdivision). */
  maxPeriodDeviation: number;
  /** Maximum RMS residual, as a fraction of the period, for the fit to be trusted. */
  maxRmsFraction: number;
  /**
   * Minimum fraction of the grid's beat slots (between the first and last
   * accepted onset) that must actually hold an onset. A real beat grid has
   * most of its slots occupied; a coincidental one -- e.g. every 4th beat of
   * a 120 BPM train happening to line up with a 3-beat, 90 BPM grid -- has
   * few, and is weak evidence however tightly those few points fit.
   */
  minGridDensity: number;
}

export const DEFAULT_REFINE_CONFIG: RefineConfig = {
  toleranceFraction: 0.12,
  minToleranceSec: 0.025,
  maxToleranceSec: 0.09,
  maxAnchors: 8,
  minAcceptedBeats: 5,
  minSpanBeats: 4,
  maxPeriodDeviation: 0.08,
  maxRmsFraction: 0.1,
  minGridDensity: 0.5,
};

export interface RefinedTempo {
  bpm: number;
  /** Fitted beat period in seconds (60 / bpm), unrounded. */
  periodSec: number;
  /**
   * The fitted time of one real beat, in the same time base as the onsets
   * passed in. Together with periodSec this fully describes the beat grid:
   * beat k lands at referenceBeatSec + k * periodSec, for any integer k
   * (including future beats -- which is what lets a click be scheduled onto
   * the player's grid rather than at an arbitrary offset from one hit).
   */
  referenceBeatSec: number;
  /** How many onsets landed on the fitted grid. */
  beats: number;
  /** Beats between the first and last accepted onset. */
  spanBeats: number;
  /** RMS of the fit residuals, in seconds -- how tightly the onsets sit on the grid. */
  rmsSec: number;
}

interface Fit {
  period: number;
  intercept: number;
  beats: number;
  spanBeats: number;
  rmsSec: number;
}

/** Least-squares line through (n, t) points from running sums. Returns null if the points don't span at least two distinct beat numbers. */
function fitLine(k: number, sumN: number, sumT: number, sumNN: number, sumNT: number): { slope: number; intercept: number } | null {
  const denom = k * sumNN - sumN * sumN;
  if (k < 2 || denom <= 1e-9) return null;
  const slope = (k * sumNT - sumN * sumT) / denom;
  const intercept = (sumT - slope * sumN) / k;
  return { slope, intercept };
}

function trackFromAnchor(onsets: number[], anchorIndex: number, coarsePeriod: number, cfg: RefineConfig): Fit | null {
  const anchorTime = onsets[anchorIndex];
  const accepted: { n: number; t: number }[] = [{ n: 0, t: anchorTime }];

  let k = 1;
  let sumN = 0;
  let sumT = anchorTime;
  let sumNN = 0;
  let sumNT = 0;

  let period = coarsePeriod;
  let intercept = anchorTime;
  let lastN = 0;

  for (let j = anchorIndex + 1; j < onsets.length; j++) {
    const t = onsets[j];
    const n = Math.round((t - intercept) / period);
    if (n <= lastN) continue; // same beat as one already accepted (or earlier): a flam/double-trigger, skip it

    const tolerance = Math.min(cfg.maxToleranceSec, Math.max(cfg.minToleranceSec, cfg.toleranceFraction * period));
    const residual = t - (intercept + period * n);
    if (Math.abs(residual) > tolerance) continue; // off the grid: ghost note, subdivision, or noise

    accepted.push({ n, t });
    k += 1;
    sumN += n;
    sumT += t;
    sumNN += n * n;
    sumNT += n * t;
    lastN = n;

    const fit = fitLine(k, sumN, sumT, sumNN, sumNT);
    if (fit && fit.slope > 0 && Math.abs(fit.slope - coarsePeriod) / coarsePeriod <= cfg.maxPeriodDeviation) {
      period = fit.slope;
      intercept = fit.intercept;
    }
  }

  const finalFit = fitLine(k, sumN, sumT, sumNN, sumNT);
  if (!finalFit || finalFit.slope <= 0) return null;

  let squared = 0;
  for (const p of accepted) {
    const r = p.t - (finalFit.intercept + finalFit.slope * p.n);
    squared += r * r;
  }

  return {
    period: finalFit.slope,
    intercept: finalFit.intercept,
    beats: k,
    spanBeats: lastN,
    rmsSec: Math.sqrt(squared / k),
  };
}

/**
 * Refine `coarseBpm` by regressing onset times onto beat numbers. Returns
 * null if no trustworthy grid fit exists (too few onsets on the grid, too
 * short a baseline, a fit that strays from the coarse tempo, or a loose fit).
 */
export function refineTempoByRegression(
  onsetTimesSec: number[],
  coarseBpm: number,
  config: Partial<RefineConfig> = {}
): RefinedTempo | null {
  const cfg = { ...DEFAULT_REFINE_CONFIG, ...config };
  if (!(coarseBpm > 0) || onsetTimesSec.length < cfg.minAcceptedBeats) return null;

  const onsets = [...onsetTimesSec].sort((a, b) => a - b);
  const coarsePeriod = 60 / coarseBpm;

  let best: Fit | null = null;
  const anchorCount = Math.min(cfg.maxAnchors, onsets.length);
  for (let a = 0; a < anchorCount; a++) {
    const fit = trackFromAnchor(onsets, a, coarsePeriod, cfg);
    if (!fit) continue;
    if (!best || fit.beats > best.beats || (fit.beats === best.beats && fit.rmsSec < best.rmsSec)) {
      best = fit;
    }
  }

  if (!best) return null;
  if (best.beats < cfg.minAcceptedBeats) return null;
  if (best.spanBeats < cfg.minSpanBeats) return null;
  if (Math.abs(best.period - coarsePeriod) / coarsePeriod > cfg.maxPeriodDeviation) return null;
  if (best.rmsSec > cfg.maxRmsFraction * best.period) return null;
  if (best.beats / (best.spanBeats + 1) < cfg.minGridDensity) return null;

  return {
    bpm: 60 / best.period,
    periodSec: best.period,
    referenceBeatSec: best.intercept,
    beats: best.beats,
    spanBeats: best.spanBeats,
    rmsSec: best.rmsSec,
  };
}

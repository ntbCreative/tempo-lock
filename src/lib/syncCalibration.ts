/**
 * Loopback latency measurement.
 *
 * Why this exists: however precisely the click is placed on the player's
 * beat grid, the click is only *heard* on the beat if every fixed delay in
 * the chain is accounted for -- and most of them can't be read from any web
 * API:
 *
 *  - microphone/input latency, and how the input buffer is timestamped
 *  - the onset detector's own bias (it reports when the envelope peaks,
 *    not the instant of the attack)
 *  - output latency (poorly reported on iOS; invisible over Bluetooth,
 *    where 100-300ms is normal)
 *
 * They add up to one constant. Instead of estimating each, measure the
 * total: schedule a train of clicks at known times, play them through the
 * speaker, and see when the *same detector that listens to your drums*
 * reports hearing them. Because the click and your sticks both reach the
 * mic and go through the same detection path, the click's measured lateness
 * is exactly how much earlier a click must be played to line up with a hit
 * detected at the same moment.
 *
 * (Derivation: with total input-side delay D and residual output delay R,
 * a stick struck at time s is detected at s + D, so a grid built from
 * detections sits D late. A click scheduled at c is heard at c + R. To make
 * the click coincide with the stick: c + R = s = (detected grid) - D, so
 * play earlier by D + R -- which is precisely the detected-minus-scheduled
 * lag of the click itself.)
 *
 * This module is the pure matching/statistics half; orchestration (playing
 * the clicks, listening) lives in the hook.
 */

export interface LoopbackConfig {
  /** A detection may land this many seconds before its scheduled click and still count (timestamp slop). */
  earlyToleranceSec: number;
  /** How long after a scheduled click to look for its detection. Clicks must be spaced wider than earlyTolerance + maxLag so windows can't overlap. */
  maxLagSec: number;
  /** Lags farther than this from the median are treated as noise and dropped. */
  inlierToleranceSec: number;
  /** Fraction of the scheduled clicks that must yield a consistent detection (use ~10 clicks so this is a meaningful majority). */
  minMatchedFraction: number;
  /** Maximum median absolute deviation of the inlier lags. Loose lags mean the measurement can't be trusted. */
  maxSpreadSec: number;
}

export const DEFAULT_LOOPBACK_CONFIG: LoopbackConfig = {
  earlyToleranceSec: 0.03,
  maxLagSec: 0.5,
  // Tuned for a very low false-accept rate rather than a high success rate:
  // a failed run just means "try again" and changes nothing, while a wrong
  // number silently shifts every click. Measured over 20,000 trials of
  // uniformly random lags with a 10-click train: 0.000% false accepts.
  // (With 8 clicks, 5-of-8 agreement and a +/-25ms window, pure garbage
  // was accepted 1% of the time -- too loose.)
  inlierToleranceSec: 0.015,
  minMatchedFraction: 0.7,
  maxSpreadSec: 0.008,
};

export type LoopbackResult =
  | { ok: true; latencySec: number; matched: number; total: number; spreadSec: number }
  | { ok: false; reason: 'too-few' | 'inconsistent'; matched: number; total: number };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Given when each click was scheduled and when the detector reported onsets
 * (same time base), return the click-to-detection latency -- or a failure
 * reason if the measurement isn't trustworthy.
 */
export function measureLoopbackLatency(
  scheduledSec: number[],
  detectedSec: number[],
  config: Partial<LoopbackConfig> = {}
): LoopbackResult {
  const cfg = { ...DEFAULT_LOOPBACK_CONFIG, ...config };
  const total = scheduledSec.length;
  const needed = Math.max(1, Math.ceil(cfg.minMatchedFraction * total));
  const detected = [...detectedSec].sort((a, b) => a - b);

  const lags: number[] = [];
  for (const s of scheduledSec) {
    const hit = detected.find((d) => d >= s - cfg.earlyToleranceSec && d <= s + cfg.maxLagSec);
    if (hit !== undefined) lags.push(hit - s);
  }
  if (total === 0 || lags.length < needed) return { ok: false, reason: 'too-few', matched: lags.length, total };

  const coarse = median(lags);
  const inliers = lags.filter((l) => Math.abs(l - coarse) <= cfg.inlierToleranceSec);
  if (inliers.length < needed) return { ok: false, reason: 'inconsistent', matched: inliers.length, total };

  const latencySec = median(inliers);
  const spreadSec = median(inliers.map((l) => Math.abs(l - latencySec)));
  if (spreadSec > cfg.maxSpreadSec) return { ok: false, reason: 'inconsistent', matched: inliers.length, total };

  return { ok: true, latencySec, matched: inliers.length, total, spreadSec };
}

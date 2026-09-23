/**
 * Autocorrelation-based tempo estimation -- the dominant approach in
 * established music-information-retrieval research and tools (Scheirer
 * 1998's comb-filter method, Ellis & Pikrakis 2006, Percival & Tzanetakis
 * 2014, and what librosa/Essentia use under the hood), and a genuinely
 * different algorithm from this app's primary estimator (tempoEstimator.ts,
 * which clusters inter-onset intervals from discrete picked onset times).
 *
 * Instead of picking discrete onset times and clustering their intervals,
 * autocorrelation finds the lag at which a continuous onset-strength
 * signal is most self-similar. This is inherently more robust to noisy or
 * imperfect onset picking, since it never has to commit to "this
 * transient is an onset, that one isn't" before estimating periodicity --
 * it works directly on the strength curve as a whole.
 *
 * Used here as a second, independent cross-validation signal alongside
 * the primary estimator: agreement between two structurally different
 * algorithms is much stronger evidence than either alone, which matters
 * most for resolving octave (half/double-time) ambiguity -- exactly the
 * failure mode most of this app's tempo-detection history has been about.
 */

export interface AutocorrelationCandidate {
  bpm: number;
  /** Normalized autocorrelation strength at this lag, roughly 0-1, after a mild perceptual weighting toward common tempos. */
  strength: number;
}

/**
 * Builds a fixed-rate onset-strength signal from a list of onset times: a
 * unit impulse at each onset's nearest sample, sampled at `hopSeconds`
 * intervals across [rangeStartSec, rangeEndSec). This is the "impulse
 * train" variant of the onset-strength envelope used in the
 * autocorrelation literature -- appropriate here since onset picking has
 * already happened upstream (see onsetDetection.ts) rather than working
 * from the raw continuous energy curve.
 */
export function buildImpulseEnvelope(
  onsetTimesSec: number[],
  rangeStartSec: number,
  rangeEndSec: number,
  hopSeconds: number
): Float32Array {
  if (hopSeconds <= 0 || rangeEndSec <= rangeStartSec) return new Float32Array(0);
  const numSamples = Math.floor((rangeEndSec - rangeStartSec) / hopSeconds);
  const envelope = new Float32Array(numSamples);
  for (const t of onsetTimesSec) {
    const idx = Math.round((t - rangeStartSec) / hopSeconds);
    if (idx >= 0 && idx < numSamples) {
      envelope[idx] = 1;
    }
  }
  return envelope;
}

/**
 * Estimates tempo candidates by autocorrelating an onset-strength
 * envelope (see buildImpulseEnvelope). Returns candidates sorted by
 * strength, restricted to [minBpm, maxBpm]. A mild perceptual bias toward
 * `preferredBpm` (established practice for resolving octave ambiguity --
 * a smooth log-Gaussian favoring more common tempos) is folded into the
 * ranking, but only enough to break near-ties between similarly-strong
 * periodicities; it can't override a clearly dominant peak.
 */
export function estimateTempoByAutocorrelation(
  envelope: Float32Array,
  hopSeconds: number,
  minBpm: number,
  maxBpm: number,
  preferredBpm = 120
): AutocorrelationCandidate[] {
  if (envelope.length < 4 || hopSeconds <= 0 || minBpm <= 0 || maxBpm <= minBpm) return [];

  let mean = 0;
  for (let i = 0; i < envelope.length; i++) mean += envelope[i];
  mean /= envelope.length;

  const centered = new Float32Array(envelope.length);
  for (let i = 0; i < envelope.length; i++) centered[i] = envelope[i] - mean;

  const minLag = Math.max(1, Math.round(60 / maxBpm / hopSeconds));
  const maxLag = Math.min(centered.length - 1, Math.round(60 / minBpm / hopSeconds));
  if (maxLag <= minLag) return [];

  let energy = 0;
  for (let i = 0; i < centered.length; i++) energy += centered[i] * centered[i];
  if (energy <= 0) return [];

  const raw: { lag: number; value: number }[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < centered.length; i++) {
      sum += centered[i] * centered[i + lag];
    }
    raw.push({ lag, value: sum / energy });
  }

  // Keep only local maxima -- distinct periodicities, not every point
  // along a broad hump around one true peak.
  const peaks = raw
    .map((entry, i) => ({ entry, i }))
    .filter(({ entry, i }) => {
      const prev = raw[i - 1];
      const next = raw[i + 1];
      return (!prev || entry.value >= prev.value) && (!next || entry.value >= next.value) && entry.value > 0;
    });

  const candidates: AutocorrelationCandidate[] = peaks.map(({ entry, i }) => {
    // Parabolic interpolation using the peak and its immediate neighbors
    // refines the lag to sub-sample precision -- without it, a fixed hop
    // size quantizes the lag grid, and that quantization error in BPM
    // terms grows at faster tempos (each 1-sample lag step covers a
    // bigger BPM range when the beat period itself is fewer samples).
    let refinedLag = entry.lag;
    const prev = raw[i - 1];
    const next = raw[i + 1];
    if (prev && next) {
      const denom = prev.value - 2 * entry.value + next.value;
      if (denom !== 0) {
        const offset = (0.5 * (prev.value - next.value)) / denom;
        if (Math.abs(offset) < 1) refinedLag = entry.lag + offset;
      }
    }
    const bpm = 60 / (refinedLag * hopSeconds);
    const logRatio = Math.log2(bpm / preferredBpm);
    const perceptualWeight = Math.exp(-(logRatio * logRatio) / (2 * 0.6 * 0.6));
    return { bpm, strength: entry.value * (0.7 + 0.3 * perceptualWeight) };
  });

  return candidates.sort((a, b) => b.strength - a.strength);
}

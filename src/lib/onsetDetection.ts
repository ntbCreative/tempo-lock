/**
 * Onset detection from raw audio samples.
 *
 * Approach: short-time RMS energy envelope -> half-wave-rectified first
 * difference ("onset envelope") -> adaptive-threshold peak picking. This is
 * a standard, cheap-to-compute energy-based onset detector that works
 * reasonably well on percussive/drum-heavy signals without needing an FFT.
 *
 * Every function here is pure (no Web Audio, no timers) so it can run
 * against synthetic sample arrays in tests exactly as it runs against live
 * microphone data in the browser.
 */

/** Compute short-time RMS energy for overlapping (or non-overlapping) frames. */
export function computeEnergyEnvelope(
  samples: Float32Array,
  frameSize: number,
  hopSize: number
): Float32Array {
  if (frameSize <= 0 || hopSize <= 0 || samples.length < frameSize) {
    return new Float32Array(0);
  }
  const numFrames = Math.floor((samples.length - frameSize) / hopSize) + 1;
  const envelope = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    const start = i * hopSize;
    let sum = 0;
    for (let j = 0; j < frameSize; j++) {
      const s = samples[start + j];
      sum += s * s;
    }
    envelope[i] = Math.sqrt(sum / frameSize);
  }
  return envelope;
}

/** Half-wave rectified first difference of an energy envelope: rises = onsets, falls = ignored. */
export function onsetEnvelopeFromEnergy(energy: Float32Array): Float32Array {
  const out = new Float32Array(energy.length);
  for (let i = 1; i < energy.length; i++) {
    const diff = energy[i] - energy[i - 1];
    out[i] = diff > 0 ? diff : 0;
  }
  return out;
}

export interface PeakPickingConfig {
  /** Seconds represented by one envelope frame (i.e. hopSize / sampleRate). */
  hopSeconds: number;
  /** How many trailing frames to use for the local adaptive-threshold median. */
  medianWindowFrames: number;
  /** Multiplier applied to the local median to set the detection threshold. */
  thresholdMultiplier: number;
  /** Minimum time between two accepted onsets, to debounce a single hit. */
  minIntervalSeconds: number;
}

export const DEFAULT_PEAK_PICKING_CONFIG: PeakPickingConfig = {
  hopSeconds: 0.01,
  medianWindowFrames: 50,
  thresholdMultiplier: 1.5,
  // A hard hit on a resonant surface (e.g. a stick tapped on a table) can
  // ring/bounce for 100ms+ after the initial transient, which a too-short
  // debounce reads as a second, spurious onset -- doubling (or worse) the
  // apparent tempo from a single hit. 150ms still comfortably permits a
  // genuine 240 BPM tempo (250ms between beats) through untouched.
  minIntervalSeconds: 0.15,
};

/** Adaptive-threshold local-maximum peak picker over an onset envelope. Returns onset times in seconds. */
export function detectOnsets(
  onsetEnvelope: Float32Array,
  config: Partial<PeakPickingConfig> = {}
): number[] {
  const cfg = { ...DEFAULT_PEAK_PICKING_CONFIG, ...config };
  const onsets: number[] = [];
  let lastOnsetTime = -Infinity;

  for (let i = 0; i < onsetEnvelope.length; i++) {
    const windowStart = Math.max(0, i - cfg.medianWindowFrames);
    const window = onsetEnvelope.slice(windowStart, i + 1);
    const sorted = Array.from(window).sort((a, b) => a - b);
    const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
    const threshold = median * cfg.thresholdMultiplier + 1e-6;

    const value = onsetEnvelope[i];
    const prev = i > 0 ? onsetEnvelope[i - 1] : 0;
    const next = i < onsetEnvelope.length - 1 ? onsetEnvelope[i + 1] : 0;
    const isLocalPeak = value > threshold && value >= prev && value >= next && value > 0;

    const time = i * cfg.hopSeconds;
    if (isLocalPeak && time - lastOnsetTime >= cfg.minIntervalSeconds) {
      onsets.push(time);
      lastOnsetTime = time;
    }
  }

  return onsets;
}

/** Convenience: raw samples straight to onset times, for callers that don't need the intermediate envelopes. */
export function detectOnsetsFromSamples(
  samples: Float32Array,
  sampleRate: number,
  frameSize: number,
  hopSize: number,
  peakConfig: Partial<PeakPickingConfig> = {}
): number[] {
  const energy = computeEnergyEnvelope(samples, frameSize, hopSize);
  const onsetEnv = onsetEnvelopeFromEnergy(energy);
  return detectOnsets(onsetEnv, { hopSeconds: hopSize / sampleRate, ...peakConfig });
}

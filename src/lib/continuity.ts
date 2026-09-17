/**
 * Tempo continuity / transition logic.
 *
 * This module owns exactly one job: turn a stream of raw, noisy tempo
 * estimates into a stable, display-worthy BPM. It knows nothing about audio,
 * onset detection or the DOM -- `updateContinuity` is a pure reducer, so it
 * is fully unit-testable and safe to reason about in isolation.
 *
 * Rules:
 *  - Small changes near the current tempo are smoothed in gradually.
 *  - Large changes (including half-time/double-time flips) require three
 *    consecutive, mutually-agreeing estimates before they replace the
 *    displayed tempo.
 *  - Weak, incoherent or missing evidence never overwrites the displayed
 *    tempo, but does erode displayed confidence and clears any pending
 *    candidate (so a brief dropout doesn't "bank" partial progress toward a
 *    tempo change).
 */

export type DetectionStatus = 'finding' | 'locked' | 'low-confidence';

export interface RawTempoEvidence {
  bpm: number;
  /** 0-1 confidence in this single estimate. */
  confidence: number;
  /** Number of onsets backing this estimate. */
  onsetCount: number;
  /** Whether this estimate is internally consistent (not contradictory/noisy). */
  coherent: boolean;
}

export interface ContinuityConfig {
  minBpm: number;
  maxBpm: number;
  /** 0-1: how much of the gap to a new small-change estimate to close per update. */
  smoothing: number;
  /** Relative gap (fraction of current BPM) above which a change is "major" rather than smoothed. */
  majorChangeThreshold: number;
  /** Relative tolerance for two pending-candidate estimates to count as "agreeing". */
  agreementTolerance: number;
  /** Consecutive agreeing major-change estimates required before committing. */
  requiredConsecutive: number;
  /** Minimum per-estimate confidence to be treated as usable evidence at all. */
  minConfidenceToAccept: number;
  /** Minimum onset count to be treated as usable evidence at all. */
  minOnsetsToAccept: number;
  /** Displayed confidence below this is reported as 'low-confidence' rather than 'locked'. */
  lowConfidenceThreshold: number;
}

export const DEFAULT_CONTINUITY_CONFIG: ContinuityConfig = {
  minBpm: 40,
  maxBpm: 240,
  smoothing: 0.25,
  majorChangeThreshold: 0.08,
  agreementTolerance: 0.05,
  requiredConsecutive: 3,
  minConfidenceToAccept: 0.35,
  // Requiring a bit more onset evidence before accepting ANY estimate
  // reduces the chance that a handful of incidental transients right as
  // listening starts (handling noise, a stray hit) alone produce a
  // confidently-accepted-but-wrong initial tempo.
  minOnsetsToAccept: 6,
  lowConfidenceThreshold: 0.4,
};

export interface PendingCandidate {
  bpm: number;
  count: number;
}

export interface ContinuityState {
  displayedBpm: number | null;
  confidence: number;
  status: DetectionStatus;
  pendingCandidate: PendingCandidate | null;
}

export function createContinuityState(): ContinuityState {
  return { displayedBpm: null, confidence: 0, status: 'finding', pendingCandidate: null };
}

/** Alias kept for readability at call sites: starting fresh IS resetting. */
export const resetContinuity = createContinuityState;

function clampBpm(bpm: number, cfg: ContinuityConfig): number {
  return Math.min(cfg.maxBpm, Math.max(cfg.minBpm, bpm));
}

function isUsableEvidence(evidence: RawTempoEvidence | null, cfg: ContinuityConfig): boolean {
  if (!evidence) return false;
  if (!evidence.coherent) return false;
  if (evidence.confidence < cfg.minConfidenceToAccept) return false;
  if (evidence.onsetCount < cfg.minOnsetsToAccept) return false;
  if (evidence.bpm < cfg.minBpm || evidence.bpm > cfg.maxBpm) return false;
  return true;
}

function statusFor(displayedBpm: number | null, confidence: number, cfg: ContinuityConfig): DetectionStatus {
  if (displayedBpm === null) return 'finding';
  return confidence >= cfg.lowConfidenceThreshold ? 'locked' : 'low-confidence';
}

/**
 * Advance continuity state by one estimate. `evidence` is `null` when no
 * estimate was available at all for this tick (e.g. silence, or not enough
 * onsets yet).
 */
export function updateContinuity(
  state: ContinuityState,
  evidence: RawTempoEvidence | null,
  configOverrides: Partial<ContinuityConfig> = {}
): ContinuityState {
  const cfg = { ...DEFAULT_CONTINUITY_CONFIG, ...configOverrides };

  if (!isUsableEvidence(evidence, cfg)) {
    // Weak, incoherent, missing, or out-of-range evidence: never overwrite
    // the displayed tempo, decay confidence, and drop any pending candidate
    // so a brief dropout doesn't carry over partial progress.
    const decayedConfidence = state.confidence * 0.4;
    return {
      displayedBpm: state.displayedBpm,
      confidence: decayedConfidence,
      status: statusFor(state.displayedBpm, decayedConfidence, cfg),
      pendingCandidate: null,
    };
  }

  const evidenceBpm = clampBpm(evidence!.bpm, cfg);

  if (state.displayedBpm === null) {
    // Initial acquisition.
    const confidence = evidence!.confidence;
    return {
      displayedBpm: evidenceBpm,
      confidence,
      status: statusFor(evidenceBpm, confidence, cfg),
      pendingCandidate: null,
    };
  }

  const relativeDiff = Math.abs(evidenceBpm - state.displayedBpm) / state.displayedBpm;

  if (relativeDiff <= cfg.majorChangeThreshold) {
    // Small drift: smooth toward it, and treat this as reaffirming the
    // current tempo (clears any pending change-of-tempo candidate).
    const smoothedBpm = clampBpm(
      state.displayedBpm + cfg.smoothing * (evidenceBpm - state.displayedBpm),
      cfg
    );
    const smoothedConfidence =
      state.confidence + cfg.smoothing * (evidence!.confidence - state.confidence);
    return {
      displayedBpm: smoothedBpm,
      confidence: smoothedConfidence,
      status: statusFor(smoothedBpm, smoothedConfidence, cfg),
      pendingCandidate: null,
    };
  }

  // Major change candidate (may be a genuine tempo change or a half/double flip).
  let pending = state.pendingCandidate;
  if (pending) {
    const agreesWithPending = Math.abs(evidenceBpm - pending.bpm) / pending.bpm <= cfg.agreementTolerance;
    pending = agreesWithPending ? { bpm: evidenceBpm, count: pending.count + 1 } : { bpm: evidenceBpm, count: 1 };
  } else {
    pending = { bpm: evidenceBpm, count: 1 };
  }

  if (pending.count >= cfg.requiredConsecutive) {
    // Enough consistent support: commit the change.
    const confidence = evidence!.confidence;
    return {
      displayedBpm: pending.bpm,
      confidence,
      status: statusFor(pending.bpm, confidence, cfg),
      pendingCandidate: null,
    };
  }

  // Still gathering consensus -- keep showing the current tempo, erode
  // confidence slightly since incoming evidence disagrees with it.
  const erodedConfidence = state.confidence * 0.95;
  return {
    displayedBpm: state.displayedBpm,
    confidence: erodedConfidence,
    status: statusFor(state.displayedBpm, erodedConfidence, cfg),
    pendingCandidate: pending,
  };
}

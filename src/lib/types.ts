/**
 * Shared types for onset detection, tempo estimation and continuity tracking.
 * Kept separate from implementation so tests and UI can import types without
 * pulling in any browser/Web Audio dependent code.
 */

/** A single tempo candidate produced by the estimator, before tie-breaking. */
export interface TempoCandidate {
  bpm: number;
  /** Relative strength of this candidate, 0-1, normalized against other candidates. */
  score: number;
  /** How many interval "votes" contributed to this candidate. */
  supportCount: number;
}

/**
 * The raw output of the tempo estimator for one analysis window. This is
 * intentionally kept separate from the smoothed/locked value shown to the
 * user (see ContinuityState) so the two concerns never get tangled.
 */
export interface TempoEstimate {
  /** Best-guess BPM for this window, or null if there wasn't enough evidence. */
  bpm: number | null;
  /** 0-1 confidence in `bpm`. */
  confidence: number;
  /** Number of onsets the estimate was derived from. */
  onsetCount: number;
  /** Whether the estimate is internally consistent (not contradictory/noisy). */
  coherent: boolean;
  /** All candidates considered, strongest first, for diagnostics. */
  candidates: TempoCandidate[];
}

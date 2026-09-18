import {
  computeEnergyEnvelope,
  onsetEnvelopeFromEnergy,
  detectOnsets,
  estimateNoiseFloor,
  maskBelowNoiseFloor,
} from '../lib/onsetDetection';
import { estimateTempo, type TempoEstimatorConfig } from '../lib/tempoEstimator';
import {
  createContinuityState,
  updateContinuity,
  type ContinuityConfig,
  type ContinuityState,
} from '../lib/continuity';

/**
 * Wires the microphone to the pure detection pipeline:
 *
 *   mic samples -> energy envelope -> onset envelope -> onset times
 *                -> tempo estimate (windowed) -> continuity tracker -> UI state
 *
 * This file is intentionally the only place that touches Web Audio / the
 * DOM; everything it calls into is pure and unit-tested on its own.
 */

export type EngineStatus =
  | 'idle'
  | 'requesting-permission'
  | 'permission-denied'
  | 'unsupported'
  | 'listening'
  | 'error';

/**
 * 'live' analyzes the raw broadband signal -- right for a stick/kit hit,
 * which is a sharp transient across the whole spectrum. 'recording' first
 * low-passes the signal to isolate the kick/bass pulse before analyzing,
 * which is what lets a full song (vocals, guitar, synths all layered in
 * the same mic pickup) come through as a clean, countable pulse instead
 * of a wash of simultaneous "onsets" from every instrument at once.
 */
export type DetectionMode = 'live' | 'recording';

export interface EngineState {
  status: EngineStatus;
  continuity: ContinuityState;
  /** 0-1 rough signal-strength meter for the UI, independent of tempo confidence. */
  signalLevel: number;
  onsetCount: number;
  errorMessage?: string;
}

export interface EngineOptions {
  smoothing: number; // 0-1, forwarded into continuity config
  sensitivity: number; // 0-1, adjusts onset detection threshold (higher = more sensitive)
  minBpm: number;
  maxBpm: number;
  mode: DetectionMode;
  onUpdate: (state: EngineState) => void;
}


const SAMPLE_RATE_HINT = 44100;
const FRAME_MS = 20; // energy frame size
const HOP_MS = 10; // hop between energy frames (50% overlap)
const ANALYSIS_INTERVAL_MS = 150; // how often we re-run tempo estimation
const ONSET_HISTORY_SECONDS = 8; // trailing window of onsets fed to the estimator
const PULL_BUFFER_SECONDS = 1.5; // how much raw audio we pull from the mic per read
// Brief silent calibration window right as listening starts: measures the
// ambient noise floor (room tone, mic self-noise) before trusting any
// onset detection. Without this, quiet steady noise -- which always
// contains small bumps relative to its own immediate surroundings -- gets
// misread as real hits, since the peak-picker's threshold is otherwise
// purely relative with no absolute floor.
const CALIBRATION_DURATION_SEC = 0.6;

function nowSeconds(): number {
  return performance.now() / 1000;
}

export function isMicrophoneSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) !== 'undefined'
  );
}

export class LiveTempoEngine {
  private options: EngineOptions;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private lowpassNode: BiquadFilterNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private analysisTimer: ReturnType<typeof setInterval> | null = null;

  private onsetTimesSec: number[] = [];
  private engineState: EngineState;

  // Noise-floor calibration state (see CALIBRATION_DURATION_SEC above).
  private calibrationStartPerfSec: number | null = null;
  private calibrationEnergySamples: number[] = [];
  private noiseFloor: number | null = null;

  // Absolute (never-resets-within-a-session) sample counters, used to
  // analyze only genuinely new audio each tick -- see runAnalysis().
  private totalSamplesReceived = 0;
  private lastAnalyzedAbsSample = 0;

  // Rolling raw-sample buffer used to compute the energy/onset envelope for
  // the most recently captured audio chunk.
  private pendingSamples: Float32Array = new Float32Array(0);

  constructor(options: EngineOptions) {
    this.options = options;
    this.engineState = {
      status: 'idle',
      continuity: createContinuityState(),
      signalLevel: 0,
      onsetCount: 0,
    };
  }

  getState(): EngineState {
    return this.engineState;
  }

  updateOptions(partial: Partial<EngineOptions>): void {
    this.options = { ...this.options, ...partial };
  }

  private emit(partial: Partial<EngineState>): void {
    this.engineState = { ...this.engineState, ...partial };
    this.options.onUpdate(this.engineState);
  }

  async start(): Promise<void> {
    if (!isMicrophoneSupported()) {
      this.emit({ status: 'unsupported' });
      return;
    }

    this.reset();
    this.emit({ status: 'requesting-permission' });

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch {
      this.emit({ status: 'permission-denied' });
      return;
    }

    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioContext = new AudioContextClass();
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

    // ScriptProcessorNode is deprecated but remains the most broadly
    // supported way to get raw PCM samples synchronously across browsers
    // without shipping a separate AudioWorklet module file.
    const bufferSize = 4096;
    this.scriptNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    this.scriptNode.onaudioprocess = (event) => this.handleAudioProcess(event);

    // In 'recording' mode, isolate the kick/bass pulse with a low-pass
    // filter before the analysis pipeline ever sees the signal, so a full
    // mix's vocals/guitar/synths don't each register as their own onsets.
    let analysisInput: AudioNode = this.sourceNode;
    if (this.options.mode === 'recording') {
      this.lowpassNode = this.audioContext.createBiquadFilter();
      this.lowpassNode.type = 'lowpass';
      this.lowpassNode.frequency.value = 150;
      this.lowpassNode.Q.value = 1;
      this.sourceNode.connect(this.lowpassNode);
      analysisInput = this.lowpassNode;
    }

    // Connect through a zero-gain node so we never play the mic back out loud.
    const silentGain = this.audioContext.createGain();
    silentGain.gain.value = 0;
    analysisInput.connect(this.scriptNode);
    this.scriptNode.connect(silentGain);
    silentGain.connect(this.audioContext.destination);

    this.analysisTimer = setInterval(() => this.runAnalysis(), ANALYSIS_INTERVAL_MS);
    this.calibrationStartPerfSec = nowSeconds();

    this.emit({ status: 'listening' });
  }

  stop(): void {
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = null;
    }
    if (this.scriptNode) {
      this.scriptNode.onaudioprocess = null;
      this.scriptNode.disconnect();
      this.scriptNode = null;
    }
    if (this.lowpassNode) {
      this.lowpassNode.disconnect();
      this.lowpassNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
    this.reset();
    this.emit({ status: 'idle' });
  }

  private reset(): void {
    this.onsetTimesSec = [];
    this.pendingSamples = new Float32Array(0);
    this.calibrationStartPerfSec = null;
    this.calibrationEnergySamples = [];
    this.noiseFloor = null;
    this.totalSamplesReceived = 0;
    this.lastAnalyzedAbsSample = 0;
    this.engineState = {
      status: this.engineState.status,
      continuity: createContinuityState(),
      signalLevel: 0,
      onsetCount: 0,
    };
  }

  private handleAudioProcess(event: AudioProcessingEvent): void {
    const input = event.inputBuffer.getChannelData(0);
    this.totalSamplesReceived += input.length;
    // Append to the pending buffer, capping total length to avoid unbounded growth.
    const combined = new Float32Array(this.pendingSamples.length + input.length);
    combined.set(this.pendingSamples, 0);
    combined.set(input, this.pendingSamples.length);
    const sampleRate = event.inputBuffer.sampleRate || SAMPLE_RATE_HINT;
    const maxSamples = Math.floor(PULL_BUFFER_SECONDS * sampleRate);
    this.pendingSamples = combined.length > maxSamples ? combined.slice(combined.length - maxSamples) : combined;

    // Cheap running signal-level meter for the UI (peak of this chunk).
    let peak = 0;
    for (let i = 0; i < input.length; i++) {
      const abs = Math.abs(input[i]);
      if (abs > peak) peak = abs;
    }
    const sensitivityGain = 0.5 + this.options.sensitivity; // 0.5x .. 1.5x
    const level = Math.max(0, Math.min(1, peak * 4 * sensitivityGain));
    this.emit({ signalLevel: level });
  }

  private runAnalysis(): void {
    const sampleRate = this.audioContext?.sampleRate || SAMPLE_RATE_HINT;
    if (this.pendingSamples.length < sampleRate * 0.3) {
      // Not enough audio yet.
      return;
    }

    const frameSize = Math.max(1, Math.round((FRAME_MS / 1000) * sampleRate));
    const hopSize = Math.max(1, Math.round((HOP_MS / 1000) * sampleRate));

    // Only analyze audio that's genuinely new since the last tick, plus a
    // small trailing overlap so the adaptive median threshold has context
    // right at the start of the new segment. Re-scanning the *entire*
    // rolling buffer from scratch every tick (the previous approach) can
    // detect the same physical transient a second time near a shifted
    // buffer boundary -- fabricating a steady stream of "onsets" that
    // track the analysis timer's own cadence rather than anything real,
    // which is indistinguishable from a real (if fast) tempo to everything
    // downstream. This is the most likely explanation for a stable,
    // fast BPM reading appearing with no real input at all.
    const overlapSamples = Math.round(0.5 * sampleRate); // matches the ~50-frame adaptive median window
    const bufferStartAbsSample = this.totalSamplesReceived - this.pendingSamples.length;
    const newStartAbsSample = Math.max(this.lastAnalyzedAbsSample, bufferStartAbsSample);
    if (newStartAbsSample >= this.totalSamplesReceived) {
      return; // nothing new since the last tick
    }

    const analysisStartAbsSample = Math.max(bufferStartAbsSample, newStartAbsSample - overlapSamples);
    const localStart = analysisStartAbsSample - bufferStartAbsSample;
    const analysisSlice = this.pendingSamples.subarray(localStart);

    const energy = computeEnergyEnvelope(analysisSlice, frameSize, hopSize);

    // Calibration: for the first CALIBRATION_DURATION_SEC after listening
    // starts, just measure the ambient noise floor -- don't attempt onset
    // detection yet, since we don't yet know what "quiet" sounds like on
    // this mic/room and can't tell a real hit from noise.
    if (this.noiseFloor === null) {
      this.calibrationEnergySamples.push(...Array.from(energy));
      const elapsed = nowSeconds() - (this.calibrationStartPerfSec ?? nowSeconds());
      if (elapsed < CALIBRATION_DURATION_SEC) {
        this.lastAnalyzedAbsSample = this.totalSamplesReceived;
        return;
      }
      this.noiseFloor = estimateNoiseFloor(this.calibrationEnergySamples);
      this.calibrationEnergySamples = [];
    }

    const onsetEnvelope = onsetEnvelopeFromEnergy(energy);

    // Sensitivity: lower threshold multiplier = more sensitive (detects quieter hits).
    const thresholdMultiplier = 2.2 - this.options.sensitivity * 1.4; // sensitivity 0..1 -> 2.2..0.8
    // Sensitivity also sets how far above the calibrated noise floor a hit
    // must clear to count at all -- the actual fix for false onsets from
    // ambient noise, independent of (and in addition to) the relative
    // adaptive threshold above.
    const noiseFloorMargin = 3.5 - this.options.sensitivity * 2.0; // sensitivity 0..1 -> 3.5x..1.5x
    const gatedOnsetEnvelope = maskBelowNoiseFloor(onsetEnvelope, energy, this.noiseFloor, noiseFloorMargin);

    const newOnsetsRelativeToSlice = detectOnsets(gatedOnsetEnvelope, {
      hopSeconds: hopSize / sampleRate,
      thresholdMultiplier,
    });

    // Convert to absolute stream time, then drop anything that falls in
    // the prepended overlap region -- those were already considered (and
    // if real, already emitted) on a previous tick.
    const sliceStartAbsSec = nowSeconds() - (this.totalSamplesReceived - analysisStartAbsSample) / sampleRate;
    const newOnsetCutoffAbsSec = nowSeconds() - (this.totalSamplesReceived - newStartAbsSample) / sampleRate;
    const newOnsetsAbsolute = newOnsetsRelativeToSlice
      .map((t) => sliceStartAbsSec + t)
      .filter((t) => t >= newOnsetCutoffAbsSec);

    this.lastAnalyzedAbsSample = this.totalSamplesReceived;

    // Merge with existing onset history, de-duplicate near-identical times,
    // and keep only a trailing window.
    const merged = [...this.onsetTimesSec, ...newOnsetsAbsolute].sort((a, b) => a - b);
    const deduped: number[] = [];
    for (const t of merged) {
      if (deduped.length === 0 || t - deduped[deduped.length - 1] > 0.05) {
        deduped.push(t);
      }
    }
    const cutoff = nowSeconds() - ONSET_HISTORY_SECONDS;
    this.onsetTimesSec = deduped.filter((t) => t >= cutoff);

    const estimatorConfig: Partial<TempoEstimatorConfig> = {
      minBpm: this.options.minBpm,
      maxBpm: this.options.maxBpm,
    };
    const priorBpm = this.engineState.continuity.displayedBpm;
    const relativeOnsets = this.onsetTimesSec.map((t) => t - this.onsetTimesSec[0]);
    const rawEstimate = estimateTempo(relativeOnsets, estimatorConfig, priorBpm);

    const continuityConfig: Partial<ContinuityConfig> = {
      minBpm: this.options.minBpm,
      maxBpm: this.options.maxBpm,
      smoothing: this.options.smoothing,
    };

    const nextContinuity = updateContinuity(
      this.engineState.continuity,
      rawEstimate.bpm === null
        ? null
        : {
            bpm: rawEstimate.bpm,
            confidence: rawEstimate.confidence,
            onsetCount: rawEstimate.onsetCount,
            coherent: rawEstimate.coherent,
          },
      continuityConfig
    );

    this.emit({ continuity: nextContinuity, onsetCount: this.onsetTimesSec.length });
  }
}

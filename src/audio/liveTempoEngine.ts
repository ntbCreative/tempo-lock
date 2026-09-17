import { computeEnergyEnvelope, onsetEnvelopeFromEnergy, detectOnsets } from '../lib/onsetDetection';
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
  onUpdate: (state: EngineState) => void;
}

const SAMPLE_RATE_HINT = 44100;
const FRAME_MS = 20; // energy frame size
const HOP_MS = 10; // hop between energy frames (50% overlap)
const ANALYSIS_INTERVAL_MS = 150; // how often we re-run tempo estimation
const ONSET_HISTORY_SECONDS = 8; // trailing window of onsets fed to the estimator
const PULL_BUFFER_SECONDS = 1.5; // how much raw audio we pull from the mic per read

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
  private scriptNode: ScriptProcessorNode | null = null;
  private analysisTimer: ReturnType<typeof setInterval> | null = null;

  private onsetTimesSec: number[] = [];
  private engineState: EngineState;

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

    // Connect through a zero-gain node so we never play the mic back out loud.
    const silentGain = this.audioContext.createGain();
    silentGain.gain.value = 0;
    this.sourceNode.connect(this.scriptNode);
    this.scriptNode.connect(silentGain);
    silentGain.connect(this.audioContext.destination);

    this.analysisTimer = setInterval(() => this.runAnalysis(), ANALYSIS_INTERVAL_MS);

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
    this.engineState = {
      status: this.engineState.status,
      continuity: createContinuityState(),
      signalLevel: 0,
      onsetCount: 0,
    };
  }

  private handleAudioProcess(event: AudioProcessingEvent): void {
    const input = event.inputBuffer.getChannelData(0);
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
    const energy = computeEnergyEnvelope(this.pendingSamples, frameSize, hopSize);
    const onsetEnvelope = onsetEnvelopeFromEnergy(energy);

    // Sensitivity: lower threshold multiplier = more sensitive (detects quieter hits).
    const thresholdMultiplier = 2.2 - this.options.sensitivity * 1.4; // sensitivity 0..1 -> 2.2..0.8

    const newOnsetsRelative = detectOnsets(onsetEnvelope, {
      hopSeconds: hopSize / sampleRate,
      thresholdMultiplier,
    });

    // These onset times are relative to the start of `pendingSamples`, which
    // slides forward over time. Anchor them to absolute stream time using
    // how much audio has been captured so far.
    const chunkStartAbsSec = nowSeconds() - this.pendingSamples.length / sampleRate;
    const newOnsetsAbsolute = newOnsetsRelative.map((t) => chunkStartAbsSec + t);

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

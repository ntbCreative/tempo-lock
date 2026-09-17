import { computeClickTimes, computeSessionPosition } from '../lib/metronomeSchedule';
import { resolveClickSound, beatIndexInBar as computeBeatIndexInBar, type AccentMode, type ClickSound } from '../lib/clickPattern';

/**
 * Plays an audible metronome click track at a fixed BPM, starting at a given
 * wall-clock (performance.now()-based) time for phase alignment with the
 * detector. Runs its own AudioContext, separate from the mic-analysis
 * context in liveTempoEngine.ts, since it needs to be audible (the mic
 * pipeline is deliberately silent).
 *
 * Uses the standard "lookahead scheduler" pattern: a cheap setInterval
 * repeatedly tops up a short window of precisely-timed clicks scheduled via
 * the AudioContext clock, which is far more accurate than timing audio
 * playback directly off setInterval/setTimeout.
 */

const LOOKAHEAD_SEC = 0.1; // how far ahead we schedule
const SCHEDULER_INTERVAL_MS = 25; // how often we top up the schedule
const CLICK_BATCH = 8; // how many upcoming clicks we compute at a time

function nowSeconds(): number {
  return performance.now() / 1000;
}

export interface MetronomeStartOptions {
  beatsPerBar?: number;
  accentMode?: AccentMode;
  customAccentBeats?: number[];
  /** Bars the session should run for; 0 (default) means "until stopped". */
  totalBars?: number;
  /** Called once, when a fixed-length session reaches its end and stops itself. */
  onFinished?: () => void;
}

export interface MetronomePosition {
  barIndex: number;
  beatInBar: number;
  remainingBars: number | null;
}

export class MetronomeEngine {
  private audioContext: AudioContext | null = null;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private perfToAudioOffset = 0; // audioContext.currentTime - perfSeconds, sampled once at start
  private nextClickIndex = 0;
  private bpm = 120;
  private beatsPerBar = 4;
  private accentMode: AccentMode = 'first';
  private customAccentBeats: number[] = [];
  private totalBars = 0;
  private onFinished: (() => void) | undefined;
  private startPerfSec = 0;
  private running = false;
  private noiseBuffer: AudioBuffer | null = null;

  isRunning(): boolean {
    return this.running;
  }

  start(bpm: number, startAtPerfSec: number, beatsPerBarOrOptions: number | MetronomeStartOptions = {}): void {
    this.stop();

    const options: MetronomeStartOptions =
      typeof beatsPerBarOrOptions === 'number' ? { beatsPerBar: beatsPerBarOrOptions } : beatsPerBarOrOptions;

    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioContext = new AudioContextClass();
    this.perfToAudioOffset = this.audioContext.currentTime - nowSeconds();
    this.noiseBuffer = this.buildNoiseBuffer(this.audioContext);

    this.bpm = bpm;
    this.beatsPerBar = options.beatsPerBar ?? 4;
    this.accentMode = options.accentMode ?? 'first';
    this.customAccentBeats = options.customAccentBeats ?? [];
    this.totalBars = options.totalBars ?? 0;
    this.onFinished = options.onFinished;
    this.startPerfSec = startAtPerfSec;
    this.nextClickIndex = 0;
    this.running = true;

    this.schedulerTimer = setInterval(() => this.scheduleUpcomingClicks(), SCHEDULER_INTERVAL_MS);
    // Run once immediately so the very first click (which may be due right away) isn't delayed.
    this.scheduleUpcomingClicks();
  }

  stop(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
    this.running = false;
  }

  /** Current bar/beat position, derived from real elapsed time (what's audibly playing right now), for UI polling. */
  getPosition(): MetronomePosition | null {
    if (!this.running) return null;
    const elapsedSec = Math.max(0, nowSeconds() - this.startPerfSec);
    const clickIndex = Math.floor(elapsedSec / (60 / this.bpm));
    const pos = computeSessionPosition(clickIndex, this.beatsPerBar, this.totalBars);
    return { barIndex: pos.barIndex, beatInBar: pos.beatInBar, remainingBars: pos.remainingBars };
  }

  private scheduleUpcomingClicks(): void {
    if (!this.audioContext || !this.running) return;

    const perfNow = nowSeconds();
    const horizonPerfSec = perfNow + LOOKAHEAD_SEC;

    const batchStartTime = this.startPerfSec + this.nextClickIndex * (60 / this.bpm);
    if (batchStartTime > horizonPerfSec) return;

    const candidateTimes = computeClickTimes(batchStartTime, this.bpm, CLICK_BATCH);
    for (let i = 0; i < candidateTimes.length; i++) {
      const clickPerfTime = candidateTimes[i];
      if (clickPerfTime > horizonPerfSec) break;

      const sessionPos = computeSessionPosition(this.nextClickIndex, this.beatsPerBar, this.totalBars);
      if (sessionPos.finished) {
        // Reached the end of a fixed-length session: stop and notify, without scheduling further clicks.
        const onFinished = this.onFinished;
        this.stop();
        onFinished?.();
        return;
      }

      const audioTime = clickPerfTime + this.perfToAudioOffset;
      if (audioTime >= this.audioContext.currentTime) {
        const beatInBar = computeBeatIndexInBar(this.nextClickIndex, this.beatsPerBar);
        const sound = resolveClickSound(beatInBar, {
          accentMode: this.accentMode,
          beatsPerBar: this.beatsPerBar,
          customAccentBeats: this.customAccentBeats,
        });
        this.playClick(audioTime, sound);
      }
      this.nextClickIndex += 1;
    }
  }

  private playClick(audioTime: number, sound: ClickSound): void {
    if (sound === 'mute') return;
    if (sound === 'clap') {
      this.playClap(audioTime);
      return;
    }

    const ctx = this.audioContext;
    if (!ctx) return;

    const accent = sound === 'accent';
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = accent ? 1500 : 1000;

    const peak = accent ? 0.35 : 0.22;
    const duration = 0.045;
    gain.gain.setValueAtTime(0, audioTime);
    gain.gain.linearRampToValueAtTime(peak, audioTime + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioTime + duration);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(audioTime);
    oscillator.stop(audioTime + duration + 0.01);
  }

  /** A short filtered noise burst, for the backbeat "clap" sound. */
  private playClap(audioTime: number): void {
    const ctx = this.audioContext;
    if (!ctx || !this.noiseBuffer) return;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1800;
    filter.Q.value = 0.9;

    const gain = ctx.createGain();
    const duration = 0.07;
    gain.gain.setValueAtTime(0, audioTime);
    gain.gain.linearRampToValueAtTime(0.5, audioTime + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioTime + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start(audioTime);
    source.stop(audioTime + duration + 0.01);
  }

  private buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const durationSec = 0.1;
    const frameCount = Math.max(1, Math.floor(ctx.sampleRate * durationSec));
    const buffer = ctx.createBuffer(1, frameCount, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frameCount; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }
}

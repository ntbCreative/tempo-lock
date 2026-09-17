import { computeSessionPosition } from '../lib/metronomeSchedule';
import {
  resolveClickSound,
  beatIndexInBar as computeBeatIndexInBar,
  clapVoiceForKit,
  type AccentMode,
  type ClickSound,
  type SoundKit,
} from '../lib/clickPattern';
import { bpmForBar, clickIndexAtElapsedTime, type TempoRampConfig } from '../lib/tempoRamp';

const LOOKAHEAD_SEC = 0.1;
const SCHEDULER_INTERVAL_MS = 25;

function nowSeconds(): number {
  return performance.now() / 1000;
}

export interface MetronomeStartOptions {
  beatsPerBar?: number;
  accentMode?: AccentMode;
  customAccentBeats?: number[];
  soundKit?: SoundKit;
  totalBars?: number;
  volumeScale?: number;
  ramp?: TempoRampConfig;
  onFinished?: () => void;
}

export interface MetronomePosition {
  barIndex: number;
  beatInBar: number;
  remainingBars: number | null;
  currentBpm: number;
}

export class MetronomeEngine {
  private audioContext: AudioContext | null = null;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private perfToAudioOffset = 0;
  private nextClickIndex = 0;
  private nextClickTimePerfSec = 0;
  private bpm = 120;
  private beatsPerBar = 4;
  private accentMode: AccentMode = 'first';
  private customAccentBeats: number[] = [];
  private soundKit: SoundKit = 'digital';
  private totalBars = 0;
  private volumeScale = 1;
  private ramp: TempoRampConfig | null = null;
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
    this.soundKit = options.soundKit ?? 'digital';
    this.totalBars = options.totalBars ?? 0;
    this.volumeScale = options.volumeScale ?? 1;
    this.ramp = options.ramp ?? null;
    this.onFinished = options.onFinished;
    this.startPerfSec = startAtPerfSec;
    this.nextClickIndex = 0;
    this.nextClickTimePerfSec = startAtPerfSec;
    this.running = true;

    this.schedulerTimer = setInterval(() => this.scheduleUpcomingClicks(), SCHEDULER_INTERVAL_MS);
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

  getPosition(): MetronomePosition | null {
    if (!this.running) return null;
    const elapsedSec = Math.max(0, nowSeconds() - this.startPerfSec);
    const clickIndex = this.ramp
      ? clickIndexAtElapsedTime(elapsedSec, this.ramp)
      : Math.floor(elapsedSec / (60 / this.bpm));
    const pos = computeSessionPosition(clickIndex, this.beatsPerBar, this.totalBars);
    const currentBpm = this.bpmForClickIndex(clickIndex);
    return { barIndex: pos.barIndex, beatInBar: pos.beatInBar, remainingBars: pos.remainingBars, currentBpm };
  }

  private bpmForClickIndex(clickIndex: number): number {
    if (!this.ramp) return this.bpm;
    const safeBeatsPerBar = this.beatsPerBar > 0 ? this.beatsPerBar : 1;
    const barIndex = Math.floor(clickIndex / safeBeatsPerBar);
    return bpmForBar(barIndex, this.ramp);
  }

  private scheduleUpcomingClicks(): void {
    if (!this.audioContext || !this.running) return;

    const horizonPerfSec = nowSeconds() + LOOKAHEAD_SEC;

    while (this.nextClickTimePerfSec <= horizonPerfSec) {
      const sessionPos = computeSessionPosition(this.nextClickIndex, this.beatsPerBar, this.totalBars);
      if (sessionPos.finished) {
        const onFinished = this.onFinished;
        this.stop();
        onFinished?.();
        return;
      }

      const bpmForThisClick = this.bpmForClickIndex(this.nextClickIndex);
      const audioTime = this.nextClickTimePerfSec + this.perfToAudioOffset;
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
      this.nextClickTimePerfSec += 60 / bpmForThisClick;
    }
  }

  private playClick(audioTime: number, sound: ClickSound): void {
    if (sound === 'mute') return;

    if (sound === 'clap') {
      if (clapVoiceForKit(this.soundKit) === 'digital-clap') {
        this.playNoiseBurst(audioTime, { freq: 1800, q: 0.9, peak: 0.5, duration: 0.07 });
      } else {
        this.playKitVoice(audioTime, true);
      }
      return;
    }

    this.playKitVoice(audioTime, sound === 'accent');
  }

  private playKitVoice(audioTime: number, accent: boolean): void {
    switch (this.soundKit) {
      case 'digital':
        this.playDigital(audioTime, accent);
        break;
      case 'woodblock':
        this.playWoodblock(audioTime, accent);
        break;
      case 'rimshot':
        this.playRimshot(audioTime, accent);
        break;
      case 'cowbell':
        this.playCowbell(audioTime, accent);
        break;
      case 'hihat':
        this.playHiHat(audioTime, accent);
        break;
      case 'clave':
        this.playClave(audioTime, accent);
        break;
    }
  }

  private playTone(
    audioTime: number,
    options: { freq: number; type?: OscillatorType; peak: number; duration: number; pitchDropTo?: number }
  ): void {
    const ctx = this.audioContext;
    if (!ctx) return;

    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = options.type ?? 'sine';
    oscillator.frequency.setValueAtTime(options.freq, audioTime);
    if (options.pitchDropTo !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(options.pitchDropTo, audioTime + options.duration);
    }

    gain.gain.setValueAtTime(0, audioTime);
    gain.gain.linearRampToValueAtTime(options.peak * this.volumeScale, audioTime + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioTime + options.duration);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(audioTime);
    oscillator.stop(audioTime + options.duration + 0.01);
  }

  private playNoiseBurst(
    audioTime: number,
    options: { freq: number; q: number; peak: number; duration: number; highpass?: boolean }
  ): void {
    const ctx = this.audioContext;
    if (!ctx || !this.noiseBuffer) return;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = options.highpass ? 'highpass' : 'bandpass';
    filter.frequency.value = options.freq;
    filter.Q.value = options.q;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, audioTime);
    gain.gain.linearRampToValueAtTime(options.peak * this.volumeScale, audioTime + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioTime + options.duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start(audioTime);
    source.stop(audioTime + options.duration + 0.01);
  }

  private playDigital(audioTime: number, accent: boolean): void {
    this.playTone(audioTime, { freq: accent ? 1500 : 1000, peak: accent ? 0.35 : 0.22, duration: 0.045 });
  }

  private playWoodblock(audioTime: number, accent: boolean): void {
    this.playTone(audioTime, {
      type: 'triangle',
      freq: accent ? 1300 : 1000,
      pitchDropTo: accent ? 700 : 550,
      peak: accent ? 0.4 : 0.26,
      duration: 0.05,
    });
  }

  private playRimshot(audioTime: number, accent: boolean): void {
    this.playNoiseBurst(audioTime, { freq: 3200, q: 1.1, peak: accent ? 0.45 : 0.28, duration: 0.03 });
    this.playTone(audioTime, { type: 'triangle', freq: accent ? 2200 : 1800, peak: accent ? 0.2 : 0.12, duration: 0.02 });
  }

  private playCowbell(audioTime: number, accent: boolean): void {
    const ctx = this.audioContext;
    if (!ctx) return;

    const duration = accent ? 0.09 : 0.06;
    const peak = (accent ? 0.32 : 0.2) * this.volumeScale;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2500;
    filter.Q.value = 2.5;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, audioTime);
    gain.gain.linearRampToValueAtTime(peak, audioTime + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioTime + duration);

    filter.connect(gain);
    gain.connect(ctx.destination);

    for (const freq of [587, 845]) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      osc.connect(filter);
      osc.start(audioTime);
      osc.stop(audioTime + duration + 0.01);
    }
  }

  private playHiHat(audioTime: number, accent: boolean): void {
    this.playNoiseBurst(audioTime, {
      freq: 7000,
      q: 0.7,
      peak: accent ? 0.3 : 0.18,
      duration: accent ? 0.035 : 0.02,
      highpass: true,
    });
  }

  private playClave(audioTime: number, accent: boolean): void {
    this.playTone(audioTime, { freq: accent ? 2600 : 2200, peak: accent ? 0.38 : 0.24, duration: 0.02 });
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

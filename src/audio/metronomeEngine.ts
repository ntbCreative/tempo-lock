import { computeSessionPosition, blendTowards } from '../lib/metronomeSchedule';
import {
  resolveClickSound,
  beatIndexInBar as computeBeatIndexInBar,
  clapVoiceForKit,
  subdivisionTicksPerBeat,
  resolveEffectiveAccentMode,
  type AccentMode,
  type ClickSound,
  type SoundKit,
  type Subdivision,
} from '../lib/clickPattern';
import { bpmForBar, clickIndexAtElapsedTime, type TempoRampConfig } from '../lib/tempoRamp';
import { effectiveTicksPerBeat, stepBeatCycle, DEFAULT_FEEL, type FeelMultiplier } from '../lib/feel';

const LOOKAHEAD_SEC = 0.1;
const SCHEDULER_INTERVAL_MS = 25;

function nowSeconds(): number {
  return performance.now() / 1000;
}

export interface MetronomeStartOptions {
  beatsPerBar?: number;
  accentMode?: AccentMode;
  /** For 'backbeat' (2 & 4 clap) mode only: play this many bars of a straight, downbeat-accented count-in before the real backbeat pattern starts. */
  backbeatCountInBars?: number;
  customAccentBeats?: number[];
  soundKit?: SoundKit;
  /** Extra evenly-spaced ticks between the main beat clicks; 'none' (default) plays just the beat itself. */
  subdivision?: Subdivision;
  /** Live half/double-time feel, separate from `subdivision` -- see setFeel(). */
  feel?: FeelMultiplier;
  totalBars?: number;
  volumeScale?: number;
  /** Extra multiplier for subdivision/feel-toggle ticks only, on top of volumeScale -- 1 = same volume as the main click's normal (unaccented) voice. */
  subdivisionVolumeScale?: number;
  /** Manual fine-tuning (milliseconds) added on top of automatic output-latency compensation -- positive plays the click earlier (for hardware whose real delay is worse than what the browser reports, e.g. Bluetooth), negative plays it later. See start()'s perfToAudioOffset computation for the full picture. */
  timingOffsetMs?: number;
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
  private nextSubTick = 0;
  private subdivisionTicks = 1;
  private feel: FeelMultiplier = DEFAULT_FEEL;
  private beatCycleCounter = 0;
  private currentTickMuted = false;
  private hasPlayedAnyClick = false;
  private bpm = 120;
  private beatsPerBar = 4;
  private accentMode: AccentMode = 'first';
  private backbeatCountInBars = 0;
  private customAccentBeats: number[] = [];
  private soundKit: SoundKit = 'digital';
  private totalBars = 0;
  private volumeScale = 1;
  /** Extra multiplier applied only to subdivision/feel-toggle ticks, on top of volumeScale -- lets them sit quieter (or louder) relative to the main click. */
  private subdivisionVolumeScale = 1;
  private ramp: TempoRampConfig | null = null;
  private onFinished: (() => void) | undefined;
  private startPerfSec = 0;
  private running = false;
  private noiseBuffer: AudioBuffer | null = null;

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Gently nudges the running tempo toward `targetBpm` instead of snapping
   * to it -- for tracking ongoing drift in a live tempo (a band naturally
   * speeding up/slowing down slightly) without an audible jump. No-ops
   * during a ramp session, which has its own programmed tempo schedule
   * that an external nudge would fight. Only affects clicks not yet
   * scheduled (anything already within the lookahead window keeps its
   * originally-scheduled timing), so it never causes a stutter.
   */
  updateBpm(targetBpm: number, blendFactor = 0.15): void {
    if (!this.running || this.ramp) return;
    this.bpm = blendTowards(this.bpm, targetBpm, blendFactor);
  }

  /**
   * Manually nudges the running tempo by an exact amount (e.g. +/-1 BPM),
   * applied immediately -- unlike updateBpm's gentle blend, this is a
   * deliberate, single-step change the person explicitly asked for, so it
   * should take effect precisely, not gradually. Same no-restart,
   * no-phase-jump behavior as updateBpm: only affects clicks not yet
   * scheduled. No-ops during a ramp session for the same reason as
   * updateBpm -- a ramp has its own programmed tempo schedule.
   */
  nudgeBpm(deltaBpm: number, minBpm = 40, maxBpm = 240): void {
    if (!this.running || this.ramp) return;
    this.bpm = Math.min(maxBpm, Math.max(minBpm, this.bpm + deltaBpm));
  }

  /**
   * Nudges the click's phase (WHEN it plays) by a small amount, without
   * touching tempo -- shifts the entire future click grid earlier
   * (negative) or later (positive), the same way a DJ nudges a turntable
   * to re-sync two decks. For "right tempo, just not quite landing on
   * the beat," which changing the BPM can't fix. Only affects clicks not
   * yet scheduled (same no-stutter guarantee as updateBpm/nudgeBpm), so
   * it takes effect within one lookahead window, not instantly -- and
   * not retroactively on whatever's already about to play.
   */
  nudgePhase(deltaSec: number): void {
    if (!this.running) return;
    this.nextClickTimePerfSec += deltaSec;
  }

  /**
   * Live-toggles half/double-time feel on the currently running click,
   * without stopping, restarting, or touching the underlying tempo/bar
   * position. Takes effect starting from the next beat boundary (or, for
   * double-time engaged mid-beat, the next sub-tick) -- never a hard cut
   * or phase jump. See src/lib/feel.ts for how this is scheduled.
   */
  setFeel(feel: FeelMultiplier): void {
    if (!this.running || feel === this.feel) return;
    this.feel = feel;
    // Restart the half-time skip cycle from *now* rather than wherever a
    // previous half-time session left off, so re-engaging it always
    // plays the very next beat instead of possibly muting it.
    this.beatCycleCounter = 0;
  }

  getFeel(): FeelMultiplier {
    return this.feel;
  }

  /** Live-adjusts the overall click volume (0-1). Applies to all future clicks immediately -- no restart needed, since volume is read fresh at the moment each click is synthesized. */
  setVolumeScale(next: number): void {
    this.volumeScale = Math.max(0, Math.min(1, next));
  }

  /** Live-adjusts the subdivision/feel-tick volume multiplier (0-1, on top of setVolumeScale). Same no-restart behavior. */
  setSubdivisionVolumeScale(next: number): void {
    this.subdivisionVolumeScale = Math.max(0, Math.min(1, next));
  }

  start(bpm: number, startAtPerfSec: number, beatsPerBarOrOptions: number | MetronomeStartOptions = {}): void {
    this.stop();

    const options: MetronomeStartOptions =
      typeof beatsPerBarOrOptions === 'number' ? { beatsPerBar: beatsPerBarOrOptions } : beatsPerBarOrOptions;

    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioContext = new AudioContextClass();
    // Web Audio's own currentTime marks when the audio graph processes a
    // sample, not when it's actually audible -- there's typically real
    // additional delay from there to the speaker (DAC conversion, OS
    // mixing, and especially Bluetooth, which can add 100ms+ that no web
    // API can see at all). outputLatency, where supported, reports the
    // known/queryable portion of that; subtracting it here means every
    // click is scheduled that much earlier so it's actually *heard*
    // closer to the intended instant, rather than a beat that's
    // technically on-time internally but audibly late.
    const latencyReportingContext = this.audioContext as unknown as { outputLatency?: number; baseLatency?: number };
    const outputLatencySec = latencyReportingContext.outputLatency ?? latencyReportingContext.baseLatency ?? 0;
    const manualOffsetSec = (options.timingOffsetMs ?? 0) / 1000;
    this.perfToAudioOffset = this.audioContext.currentTime - nowSeconds() - outputLatencySec - manualOffsetSec;
    this.noiseBuffer = this.buildNoiseBuffer(this.audioContext);

    this.bpm = bpm;
    this.beatsPerBar = options.beatsPerBar ?? 4;
    this.accentMode = options.accentMode ?? 'first';
    this.backbeatCountInBars = options.backbeatCountInBars ?? 0;
    this.customAccentBeats = options.customAccentBeats ?? [];
    this.soundKit = options.soundKit ?? 'digital';
    this.subdivisionTicks = subdivisionTicksPerBeat(options.subdivision ?? 'none');
    this.feel = options.feel ?? 1;
    this.beatCycleCounter = 0;
    this.currentTickMuted = false;
    this.hasPlayedAnyClick = false;
    this.totalBars = options.totalBars ?? 0;
    this.volumeScale = options.volumeScale ?? 1;
    this.subdivisionVolumeScale = options.subdivisionVolumeScale ?? 1;
    this.ramp = options.ramp ?? null;
    this.onFinished = options.onFinished;
    this.startPerfSec = startAtPerfSec;
    this.nextClickIndex = 0;
    this.nextClickTimePerfSec = startAtPerfSec;
    this.nextSubTick = 0;
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
      const isMainBeat = this.nextSubTick === 0;

      if (isMainBeat) {
        const sessionPos = computeSessionPosition(this.nextClickIndex, this.beatsPerBar, this.totalBars);
        if (sessionPos.finished) {
          const onFinished = this.onFinished;
          this.stop();
          onFinished?.();
          return;
        }
        const { mute, nextCounter } = stepBeatCycle(this.beatCycleCounter, this.feel);
        this.currentTickMuted = mute;
        this.beatCycleCounter = nextCounter;
      }

      const bpmForThisBeat = this.bpmForClickIndex(this.nextClickIndex);
      const effectiveTicks = effectiveTicksPerBeat(this.subdivisionTicks, this.feel);
      const rawAudioTime = this.nextClickTimePerfSec + this.perfToAudioOffset;
      // The very first click of a session is scheduled for a specific
      // future instant (e.g. an exact bar boundary from the auto-start
      // countdown), but the code that decides *when* to start reacts on a
      // polling interval, not instantly -- so by the time start() actually
      // runs, that instant may already be a few tens of milliseconds in
      // the past. Silently dropping it (like any other late click) would
      // skip straight to the next beat, which sounds like a brief pause
      // before the click "catches on." Instead, only for this first ever
      // click, nudge it up to right now if it's already passed, rather
      // than waiting a full beat.
      const audioTime =
        !this.hasPlayedAnyClick && rawAudioTime < this.audioContext.currentTime
          ? this.audioContext.currentTime + 0.01
          : rawAudioTime;
      if (audioTime >= this.audioContext.currentTime && !this.currentTickMuted) {
        if (isMainBeat) {
          const beatInBar = computeBeatIndexInBar(this.nextClickIndex, this.beatsPerBar);
          const barIndex = Math.floor(this.nextClickIndex / this.beatsPerBar);
          const effectiveAccentMode = resolveEffectiveAccentMode(this.accentMode, barIndex, this.backbeatCountInBars);
          const sound = resolveClickSound(beatInBar, {
            accentMode: effectiveAccentMode,
            beatsPerBar: this.beatsPerBar,
            customAccentBeats: this.customAccentBeats,
          });
          this.playClick(audioTime, sound);
        } else {
          this.playSubdivisionTick(audioTime);
        }
        this.hasPlayedAnyClick = true;
      }

      this.nextSubTick += 1;
      if (this.nextSubTick >= effectiveTicks) {
        this.nextSubTick = 0;
        this.nextClickIndex += 1;
      }
      this.nextClickTimePerfSec += 60 / bpmForThisBeat / effectiveTicks;
    }
  }

  private playClick(audioTime: number, sound: ClickSound): void {
    if (sound === 'mute') return;

    if (sound === 'clap') {
      if (clapVoiceForKit(this.soundKit) === 'digital-clap') {
        this.playNoiseBurst(audioTime, { freq: 1800, q: 0.9, peak: 0.95, duration: 0.07 });
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
      case 'kick':
        this.playKick(audioTime, accent);
        break;
      case 'snare':
        this.playSnare(audioTime, accent);
        break;
      case 'shaker':
        this.playShaker(audioTime, accent);
        break;
      case 'triangle':
        this.playTriangle(audioTime, accent);
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
    this.playTone(audioTime, { freq: accent ? 1500 : 1000, peak: accent ? 0.95 : 0.75, duration: 0.045 });
  }

  private playWoodblock(audioTime: number, accent: boolean): void {
    this.playTone(audioTime, {
      type: 'triangle',
      freq: accent ? 1300 : 1000,
      pitchDropTo: accent ? 700 : 550,
      peak: accent ? 0.95 : 0.75,
      duration: 0.05,
    });
  }

  // Rimshot layers noise + a tone simultaneously; each layer is capped
  // lower than a single-voice sound so their sum can't push the final
  // output past 1.0 and hard-clip (louder-but-distorted is a worse
  // outcome than "loud and clean").
  private playRimshot(audioTime: number, accent: boolean): void {
    this.playNoiseBurst(audioTime, { freq: 3200, q: 1.1, peak: accent ? 0.6 : 0.48, duration: 0.03 });
    this.playTone(audioTime, { type: 'triangle', freq: accent ? 2200 : 1800, peak: accent ? 0.32 : 0.22, duration: 0.02 });
  }

  // Two simultaneous square-wave oscillators can sum to roughly double
  // amplitude at their peaks, so this kit's ceiling is capped well below
  // the single-voice max for the same reason as rimshot above.
  private playCowbell(audioTime: number, accent: boolean): void {
    const ctx = this.audioContext;
    if (!ctx) return;

    const duration = accent ? 0.09 : 0.06;
    const peak = (accent ? 0.5 : 0.36) * this.volumeScale;
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
      peak: accent ? 0.9 : 0.65,
      duration: accent ? 0.035 : 0.02,
      highpass: true,
    });
  }

  private playClave(audioTime: number, accent: boolean): void {
    this.playTone(audioTime, { freq: accent ? 2600 : 2200, peak: accent ? 0.95 : 0.75, duration: 0.02 });
  }

  /** A low sine thump with a fast downward pitch sweep -- classic simple kick-drum synthesis. */
  private playKick(audioTime: number, accent: boolean): void {
    this.playTone(audioTime, {
      freq: accent ? 165 : 140,
      pitchDropTo: accent ? 48 : 42,
      peak: accent ? 0.95 : 0.75,
      duration: accent ? 0.13 : 0.1,
    });
  }

  // Noise (the "crack") + a low tone (the "body") layered together, same
  // headroom reasoning as rimshot above.
  private playSnare(audioTime: number, accent: boolean): void {
    this.playNoiseBurst(audioTime, { freq: 2200, q: 0.8, peak: accent ? 0.6 : 0.46, duration: accent ? 0.09 : 0.07 });
    this.playTone(audioTime, { freq: accent ? 200 : 180, peak: accent ? 0.3 : 0.2, duration: 0.03 });
  }

  /** A soft, slightly longer high-passed noise burst -- gentler attack than the hi-hat, more of a sustained "shh" than a sharp tick. */
  private playShaker(audioTime: number, accent: boolean): void {
    this.playNoiseBurst(audioTime, {
      freq: 6000,
      q: 0.5,
      peak: accent ? 0.85 : 0.6,
      duration: accent ? 0.08 : 0.06,
      highpass: true,
    });
  }

  // Two closely-detuned high sine oscillators for a shimmering ring, held
  // simultaneously -- capped for the same two-source headroom reason as
  // cowbell above, with a longer decay than the other ticks for a real
  // "ring" rather than a short blip.
  private playTriangle(audioTime: number, accent: boolean): void {
    const ctx = this.audioContext;
    if (!ctx) return;

    const duration = accent ? 0.22 : 0.16;
    const peak = (accent ? 0.5 : 0.36) * this.volumeScale;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, audioTime);
    gain.gain.linearRampToValueAtTime(peak, audioTime + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioTime + duration);
    gain.connect(ctx.destination);

    for (const freq of [2800, 2850]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(audioTime);
      osc.stop(audioTime + duration + 0.01);
    }
  }

  /** Subdivision and live-feel extra ticks use the same kit voice as the main click (unaccented), so they sound consistent with it rather than a generic, unrelated tone -- at their own relative volume (subdivisionVolumeScale), on top of the overall volumeScale. */
  private playSubdivisionTick(audioTime: number): void {
    const mainVolumeScale = this.volumeScale;
    this.volumeScale = mainVolumeScale * this.subdivisionVolumeScale;
    this.playKitVoice(audioTime, false);
    this.volumeScale = mainVolumeScale;
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

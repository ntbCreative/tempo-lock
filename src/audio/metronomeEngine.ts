import { computeClickTimes, isDownbeat } from '../lib/metronomeSchedule';

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

export class MetronomeEngine {
  private audioContext: AudioContext | null = null;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private perfToAudioOffset = 0; // audioContext.currentTime - perfSeconds, sampled once at start
  private nextClickIndex = 0;
  private bpm = 120;
  private beatsPerBar = 4;
  private startPerfSec = 0;
  private running = false;

  isRunning(): boolean {
    return this.running;
  }

  start(bpm: number, startAtPerfSec: number, beatsPerBar = 4): void {
    this.stop();

    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioContext = new AudioContextClass();
    this.perfToAudioOffset = this.audioContext.currentTime - nowSeconds();

    this.bpm = bpm;
    this.beatsPerBar = beatsPerBar;
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

  private scheduleUpcomingClicks(): void {
    if (!this.audioContext || !this.running) return;

    const perfNow = nowSeconds();
    const horizonPerfSec = perfNow + LOOKAHEAD_SEC;

    // Pull the next batch of click times (in perf-clock seconds) and
    // schedule any that fall within the lookahead window.
    const batchStartTime = this.startPerfSec + this.nextClickIndex * (60 / this.bpm);
    if (batchStartTime > horizonPerfSec) return;

    const candidateTimes = computeClickTimes(batchStartTime, this.bpm, CLICK_BATCH);
    for (let i = 0; i < candidateTimes.length; i++) {
      const clickPerfTime = candidateTimes[i];
      if (clickPerfTime > horizonPerfSec) break;
      const audioTime = clickPerfTime + this.perfToAudioOffset;
      if (audioTime >= this.audioContext.currentTime) {
        this.playClick(audioTime, isDownbeat(this.nextClickIndex, this.beatsPerBar));
      }
      this.nextClickIndex += 1;
    }
  }

  private playClick(audioTime: number, accent: boolean): void {
    const ctx = this.audioContext;
    if (!ctx) return;

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
}

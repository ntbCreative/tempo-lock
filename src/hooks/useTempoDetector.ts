import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LiveTempoEngine,
  isMicrophoneSupported,
  requestMicrophonePermissionEarly,
  type EngineState,
  type DetectionMode,
} from '../audio/liveTempoEngine';
import { MetronomeEngine, type MetronomePosition } from '../audio/metronomeEngine';
import { createContinuityState } from '../lib/continuity';
import {
  createBarCountdownState,
  updateBarCountdown,
  checkStabilityTrigger,
  type BarCount,
  type BarCountdownState,
} from '../lib/metronomeSchedule';
import { countInStartOnGrid, gridBpm, nextDownbeatOnGrid } from '../lib/beatGrid';
import { measureLoopbackLatency } from '../lib/syncCalibration';
import { eventTimeToPerfSec } from '../lib/clickSync';
import type { BeatGrid } from '../lib/types';
import { parseCustomAccentBeats, type AccentMode, type SoundKit, type Subdivision } from '../lib/clickPattern';
import type { TempoRampConfig } from '../lib/tempoRamp';
import type { FeelMultiplier } from '../lib/feel';
import { createTapTempoState, registerTap, type TapTempoState } from '../lib/tapTempo';
import { parseStoredSettings, serializeSettings } from '../lib/settingsStorage';
import { moveItem } from '../lib/layoutOrder';
import { DEFAULT_THEME, type ThemeId, DEFAULT_COLOR_SCHEME, type ColorScheme } from '../lib/themes';
import { addPreset, updatePreset, deletePreset, findPreset, type Preset } from '../lib/presets';

const POSITION_POLL_MS = 100;

const SETTINGS_STORAGE_KEY = 'tempo-lock:settings';
/** Rolling window (seconds) kept for the live tempo graph. */
const GRAPH_WINDOW_SEC = 60;

/** Range of the manual click-timing offset (ms). Wide enough for Bluetooth output, which alone is commonly 100-300ms. */
export const MAX_TIMING_OFFSET_MS = 500;

/** Sync calibration: a 10-click train at 75 BPM (0.8s apart, so detection windows can't overlap). */
const CAL_CLICKS = 10;
const CAL_BPM = 75;
/** Seconds before the first click: the mic engine spends its first 0.6s calibrating the noise floor, and clicks played during that would be missed. */
const CAL_LEADIN_SEC = 1.1;
/** Seconds to keep listening after the last click so its detection can arrive. */
const CAL_TAIL_SEC = 0.8;

export interface SyncCalibrationState {
  status: 'idle' | 'running' | 'done' | 'failed';
  message: string;
}
const THEME_STORAGE_KEY = 'tempo-lock:theme';
const COLOR_SCHEME_STORAGE_KEY = 'tempo-lock:color-scheme';
const SECTION_ORDER_STORAGE_KEY = 'tempo-lock:section-order';
const MAIN_SECTION_ORDER_STORAGE_KEY = 'tempo-lock:main-section-order';
const PRESETS_STORAGE_KEY = 'tempo-lock:presets';

export type SettingsSectionId = 'detector' | 'clickTrack' | 'sounds' | 'practice' | 'appearance';

export const DEFAULT_SECTION_ORDER: SettingsSectionId[] = ['detector', 'clickTrack', 'sounds', 'practice', 'appearance'];

/** The main screen's reorderable blocks, below the fixed BPM readout/meters, which always stay anchored at the top. */
export type MainSectionId = 'mode' | 'start' | 'tap' | 'click';

export const DEFAULT_MAIN_SECTION_ORDER: MainSectionId[] = ['mode', 'start', 'tap', 'click'];

export interface DetectorSettings {
  smoothing: number;
  sensitivity: number;
  minBpm: number;
  maxBpm: number;
  /** 'live' analyzes the raw signal (right for stick/kit hits); 'recording' low-passes it first to isolate the kick/bass pulse in a full mix. */
  mode: DetectionMode;
  metronomeBars: BarCount;
  beatsPerBar: number;
  accentMode: AccentMode;
  customAccentBeatsInput: string;
  /** For 'backbeat' (2 & 4 clap) mode only: a straight quarter-note count-in for this many bars before the real backbeat pattern starts. 0 disables it. */
  backbeatCountInBars: 0 | 1 | 2;
  clickTrackLengthBars: number;
  soundKit: SoundKit;
  /** Extra evenly-spaced ticks between the main beat clicks. */
  subdivision: Subdivision;
  /** Overall click track volume, 0-1. Applies to both auto-triggered and manual clicks; the count-in's own quieter volume is relative to this. */
  masterVolume: number;
  /** Relative volume of subdivision/feel-toggle ticks, 0-1, on top of masterVolume -- 1 = same volume as the main click. */
  subdivisionVolume: number;
  /** Manual timing fine-tune (ms) on top of automatic output-latency compensation -- positive plays the click earlier, for hardware (e.g. Bluetooth) whose real output delay is worse than the browser can report. */
  clickTimingOffsetMs: number;
  countInEnabled: boolean;
  countInVolume: number;
  rampEnabled: boolean;
  rampTargetBpm: number;
  rampBpmStep: number;
  rampBarsPerStep: number;
  /**
   * While a click track plays and the mic is still listening, continuously
   * nudge the click's tempo toward whatever's detected. Off by default:
   * if the device's speaker output reaches its own mic at all (common on
   * a phone), the click can start hearing itself and reinforcing that,
   * compounding into a runaway tempo over time. Safe with headphones or
   * an isolated mic setup, but not something to risk on by default.
   */
  liveTempoTrackingEnabled: boolean;
}

export const DEFAULT_SETTINGS: DetectorSettings = {
  smoothing: 0.25,
  sensitivity: 0.5,
  minBpm: 40,
  maxBpm: 240,
  mode: 'live',
  metronomeBars: 0,
  beatsPerBar: 4,
  accentMode: 'first',
  customAccentBeatsInput: '1',
  backbeatCountInBars: 0,
  clickTrackLengthBars: 0,
  soundKit: 'digital',
  subdivision: 'none',
  masterVolume: 1,
  subdivisionVolume: 1,
  clickTimingOffsetMs: 0,
  countInEnabled: true,
  countInVolume: 0.35,
  rampEnabled: false,
  rampTargetBpm: 140,
  rampBpmStep: 5,
  rampBarsPerStep: 4,
  liveTempoTrackingEnabled: false,
};

export interface SongPresetData {
  manualBpm: number;
  beatsPerBar: number;
  accentMode: AccentMode;
  customAccentBeatsInput: string;
  backbeatCountInBars: 0 | 1 | 2;
  soundKit: SoundKit;
  subdivision: Subdivision;
  clickTrackLengthBars: number;
  metronomeBars: BarCount;
}

function loadInitial<T extends object>(key: string, defaults: T): T {
  if (typeof window === 'undefined') return defaults;
  return parseStoredSettings(window.localStorage.getItem(key), defaults);
}

/** Reconciles a persisted section order against the current known sections: keeps the user's ordering, drops any stale/unknown ids, and appends any new sections (e.g. added in an update) at the end rather than dropping them silently. */
function loadInitialSectionOrder(): SettingsSectionId[] {
  const stored = loadInitial(SECTION_ORDER_STORAGE_KEY, { order: DEFAULT_SECTION_ORDER }).order;
  const known = new Set<SettingsSectionId>(DEFAULT_SECTION_ORDER);
  const kept = stored.filter((id): id is SettingsSectionId => known.has(id as SettingsSectionId));
  const missing = DEFAULT_SECTION_ORDER.filter((id) => !kept.includes(id));
  return [...kept, ...missing];
}

/** Same reconciliation as loadInitialSectionOrder, for the main screen's reorderable blocks. */
function loadInitialMainSectionOrder(): MainSectionId[] {
  const stored = loadInitial(MAIN_SECTION_ORDER_STORAGE_KEY, { order: DEFAULT_MAIN_SECTION_ORDER }).order;
  const known = new Set<MainSectionId>(DEFAULT_MAIN_SECTION_ORDER);
  const kept = stored.filter((id): id is MainSectionId => known.has(id as MainSectionId));
  const missing = DEFAULT_MAIN_SECTION_ORDER.filter((id) => !kept.includes(id));
  return [...kept, ...missing];
}

export function useTempoDetector() {
  const [settings, setSettings] = useState<DetectorSettings>(() => loadInitial(SETTINGS_STORAGE_KEY, DEFAULT_SETTINGS));
  const [theme, setThemeState] = useState<ThemeId>(
    () => loadInitial(THEME_STORAGE_KEY, { theme: DEFAULT_THEME }).theme
  );
  const [colorScheme, setColorSchemeState] = useState<ColorScheme>(
    () => loadInitial(COLOR_SCHEME_STORAGE_KEY, { colorScheme: DEFAULT_COLOR_SCHEME }).colorScheme
  );
  const [sectionOrder, setSectionOrder] = useState<SettingsSectionId[]>(loadInitialSectionOrder);
  const [mainSectionOrder, setMainSectionOrder] = useState<MainSectionId[]>(loadInitialMainSectionOrder);
  const [presets, setPresets] = useState<Preset<SongPresetData>[]>(
    () => loadInitial(PRESETS_STORAGE_KEY, { list: [] as Preset<SongPresetData>[] }).list
  );
  const [engineState, setEngineState] = useState<EngineState>({
    status: 'idle',
    continuity: createContinuityState(),
    signalLevel: 0,
    onsetCount: 0,
    candidates: [],
    frozen: false,
    firstOnsetTimeSec: null,
    beatGrid: null,
  });
  const [tapState, setTapState] = useState<TapTempoState>(createTapTempoState());
  const [metronomeActive, setMetronomeActive] = useState(false);
  const [metronomeBpm, setMetronomeBpm] = useState<number | null>(null);
  // A rolling window of {t, bpm} samples for the live tempo graph (like
  // BPM Detector's "Variation Tracker" / Live BPM's tempo curve) -- shows
  // stability over time, not just the instant reading. Sampled roughly
  // once a second (not every engine tick) so the graph reads as a trend,
  // not raw jitter.
  const [bpmHistory, setBpmHistory] = useState<{ t: number; bpm: number }[]>([]);
  const lastGraphSampleRef = useRef(0);
  const [calibration, setCalibration] = useState<SyncCalibrationState>({ status: 'idle', message: '' });
  // True while a sync calibration is playing clicks into the mic. None of
  // the normal listening logic (auto-start, session resets) should react to
  // that deliberate test signal.
  const calibratingRef = useRef(false);
  const [syncFeedback, setSyncFeedback] = useState('');
  const [metronomePosition, setMetronomePosition] = useState<MetronomePosition | null>(null);
  const [feel, setFeelState] = useState<FeelMultiplier>(1);
  const [manualBpm, setManualBpmState] = useState(120);

  const engineRef = useRef<LiveTempoEngine | null>(null);
  const metronomeEngineRef = useRef<MetronomeEngine | null>(null);
  const countInEngineRef = useRef<MetronomeEngine | null>(null);
  const barCountdownRef = useRef<BarCountdownState>(createBarCountdownState());
  const settingsRef = useRef(settings);
  const positionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set when the user explicitly stops the auto-triggered click track while
  // still listening. Without this, the countdown would immediately re-arm
  // itself (the tempo is often still being detected) and silently restart
  // the click a few seconds later, making "Stop Click Track" look broken.
  // Cleared on a fresh Start Listening or a metronomeBars settings change,
  // both of which are legitimate re-arm points.
  const autoStartSuppressedRef = useRef(false);

  // Once the person manually nudges or adjusts the running click's tempo,
  // stop the background live-tracking drift-correction (if enabled) from
  // fighting that decision and blending it back toward the detected
  // tempo a moment later -- an explicit correction should stick, not get
  // silently undone. Reset whenever a fresh click session starts.
  const liveTrackingSuppressedRef = useRef(false);

  // Tracks whether the "Once stable" adaptive auto-start (see
  // checkStabilityTrigger) has already fired this listening session, so
  // it only triggers once. Reset alongside autoStartSuppressedRef on a
  // fresh session.
  const stabilityTriggeredRef = useRef(false);
  const REQUIRED_STABLE_TICKS = 15; // ~2.25s at the ~150ms analysis interval
  // How far ahead of the click's target instant the auto-start trigger fires.
  // Detection updates arrive every ~90-150ms, so a trigger that waited for
  // the instant itself would land on average ~half an update late, and the
  // engine would have to play the first click "now" instead of on time.
  // Firing this early lets the click be queued into the audio graph in
  // advance and land sample-accurately.
  const START_LEAD_SEC = 0.3;
  // The most recent fitted beat grid, kept briefly so a single tick where the
  // fit is momentarily unavailable doesn't drop the click back to the
  // less-precise single-hit anchoring at exactly the wrong moment.
  const GRID_MAX_AGE_SEC = 2;
  const lastGridRef = useRef<{ grid: BeatGrid; atSec: number } | null>(null);
  // Set right before a successful auto-start trigger calls engine.stop() to
  // actually release the mic. That stop() synchronously re-invokes this
  // same onUpdate handler (status -> 'idle') before triggerMetronomeStart
  // even returns -- without this guard, the reset branch below would see
  // the click it just started as "still running" and immediately stop it
  // again, since from its normal perspective a non-listening status means
  // the person stopped everything. This flag tells it that's not the case
  // this time.
  const autoStoppedListeningRef = useRef(false);

  const clampBpm = useCallback(
    (bpm: number) => Math.min(settingsRef.current.maxBpm, Math.max(settingsRef.current.minBpm, bpm)),
    []
  );

  const stopPositionPoll = useCallback(() => {
    if (positionPollRef.current) {
      clearInterval(positionPollRef.current);
      positionPollRef.current = null;
    }
    setMetronomePosition(null);
  }, []);

  const startPositionPoll = useCallback(() => {
    stopPositionPoll();
    positionPollRef.current = setInterval(() => {
      setMetronomePosition(metronomeEngineRef.current?.getPosition() ?? null);
    }, POSITION_POLL_MS);
  }, [stopPositionPoll]);

  /** Internal: stops the click track and count-in, without touching auto-start suppression. Used for legitimate resets (settings change, unmount, session end) where re-arming is correct. */
  const stopMetronomeInternal = useCallback(() => {
    metronomeEngineRef.current?.stop();
    countInEngineRef.current?.stop();
    barCountdownRef.current = createBarCountdownState();
    stabilityTriggeredRef.current = false;
    setMetronomeActive(false);
    setMetronomeBpm(null);
    setFeelState(1);
    liveTrackingSuppressedRef.current = false;
    setSyncFeedback('');
    stopPositionPoll();
  }, [stopPositionPoll]);

  /** User-facing stop (the "Stop Click Track" button): also suppresses the auto-start countdown from re-arming itself for the rest of this listening session. */
  const stopMetronome = useCallback(() => {
    autoStartSuppressedRef.current = true;
    stopMetronomeInternal();
  }, [stopMetronomeInternal]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, serializeSettings(settings));
  }, [settings]);

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, serializeSettings({ theme }));
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, serializeSettings({ colorScheme }));
  }, [colorScheme]);

  useEffect(() => {
    window.localStorage.setItem(SECTION_ORDER_STORAGE_KEY, serializeSettings({ order: sectionOrder }));
  }, [sectionOrder]);

  useEffect(() => {
    window.localStorage.setItem(MAIN_SECTION_ORDER_STORAGE_KEY, serializeSettings({ order: mainSectionOrder }));
  }, [mainSectionOrder]);

  useEffect(() => {
    window.localStorage.setItem(PRESETS_STORAGE_KEY, serializeSettings({ list: presets }));
  }, [presets]);

  // Volume applies live to whatever's currently playing -- no restart needed.
  useEffect(() => {
    metronomeEngineRef.current?.setVolumeScale(settings.masterVolume);
    countInEngineRef.current?.setVolumeScale(settings.masterVolume * settings.countInVolume);
  }, [settings.masterVolume, settings.countInVolume]);

  useEffect(() => {
    metronomeEngineRef.current?.setSubdivisionVolumeScale(settings.subdivisionVolume);
    countInEngineRef.current?.setSubdivisionVolumeScale(settings.subdivisionVolume);
  }, [settings.subdivisionVolume]);

  useEffect(() => {
    engineRef.current = new LiveTempoEngine({
      ...settings,
      onUpdate: (state) => {
        setEngineState(state);
        if (calibratingRef.current) return;

        if (state.status !== 'listening') {
          if (!autoStoppedListeningRef.current && (metronomeEngineRef.current?.isRunning() || countInEngineRef.current?.isRunning())) {
            metronomeEngineRef.current?.stop();
            countInEngineRef.current?.stop();
            setMetronomeActive(false);
            setMetronomeBpm(null);
            stopPositionPoll();
          }
          barCountdownRef.current = createBarCountdownState();
          stabilityTriggeredRef.current = false;
          autoStartSuppressedRef.current = false; // a fresh session can always auto-start again
          autoStoppedListeningRef.current = false;
          lastGridRef.current = null;
          return;
        }

        if (state.continuity.displayedBpm !== null) {
          const nowSec = performance.now() / 1000;
          if (nowSec - lastGraphSampleRef.current >= 1) {
            lastGraphSampleRef.current = nowSec;
            const bpm = state.continuity.displayedBpm;
            setBpmHistory((prev) => {
              const cutoff = nowSec - GRAPH_WINDOW_SEC;
              const next = prev.filter((p) => p.t >= cutoff);
              next.push({ t: nowSec, bpm });
              return next;
            });
          }
        }

        if (autoStartSuppressedRef.current) {
          // User explicitly stopped the click track this session: don't
          // silently restart it just because the tempo is still detected.
          return;
        }

        const cfg = settingsRef.current;

        const nowSecForGrid = performance.now() / 1000;
        if (state.beatGrid) lastGridRef.current = { grid: state.beatGrid, atSec: nowSecForGrid };
        const freshGrid = (): BeatGrid | null => {
          const g = lastGridRef.current;
          return g && nowSecForGrid - g.atSec <= GRID_MAX_AGE_SEC ? g.grid : null;
        };
        const clampClickBpm = (bpm: number) => Math.min(cfg.maxBpm, Math.max(cfg.minBpm, bpm));

        const triggerMetronomeStart = (bpm: number, startTimeSec: number) => {
          countInEngineRef.current?.stop();
          if (!metronomeEngineRef.current) {
            metronomeEngineRef.current = new MetronomeEngine();
          }
          metronomeEngineRef.current.start(bpm, startTimeSec, {
            beatsPerBar: cfg.beatsPerBar,
            accentMode: cfg.accentMode,
            backbeatCountInBars: cfg.backbeatCountInBars,
            customAccentBeats: parseCustomAccentBeats(cfg.customAccentBeatsInput, cfg.beatsPerBar),
            soundKit: cfg.soundKit,
            subdivision: cfg.subdivision,
            volumeScale: cfg.masterVolume,
            subdivisionVolumeScale: cfg.subdivisionVolume,
            timingOffsetMs: cfg.clickTimingOffsetMs,
            totalBars: 0,
          });
          setMetronomeActive(true);
          setMetronomeBpm(bpm);
          setFeelState(1);
          liveTrackingSuppressedRef.current = false;
          startPositionPoll();
          // Gig-ready: once a tempo has been confirmed and the click starts,
          // stop listening entirely for the rest of this session -- not
          // just pause re-evaluation, but actually release the mic. A
          // locked-in tempo drifting afterward, even silently, undermines
          // the one thing this workflow needs to be trustworthy, and once
          // the click has taken over there's no reason to keep the mic
          // open at all. autoStoppedListeningRef tells the reset logic
          // this stop() is expected and shouldn't tear down the click that
          // was just started.
          autoStoppedListeningRef.current = true;
          engineRef.current?.stop();
        };

        if (cfg.metronomeBars === -1) {
          // Adaptive "Once stable" auto-start: no fixed bar count, so no
          // bar-countdown machinery and no count-in (there's no fixed
          // length to count down through) -- just wait for the reading to
          // genuinely settle, then start directly, phase-aligned to the
          // session's first-onset anchor.
          if (!stabilityTriggeredRef.current) {
            const stabilityResult = checkStabilityTrigger(
              state.continuity.displayedBpm,
              state.continuity.stableTicks,
              REQUIRED_STABLE_TICKS,
              nowSecForGrid,
              state.firstOnsetTimeSec,
              cfg.beatsPerBar,
              START_LEAD_SEC
            );
            if (
              stabilityResult.shouldStartMetronome &&
              stabilityResult.metronomeBpm !== null &&
              stabilityResult.metronomeStartTimeSec !== null
            ) {
              let clickBpm = stabilityResult.metronomeBpm;
              let startTimeSec = stabilityResult.metronomeStartTimeSec;
              // Prefer the player's own fitted grid: the next downbeat on it,
              // and its (unsmoothed, best-available) tempo, instead of an
              // offset from one hit at the possibly-lagging displayed BPM.
              const grid = freshGrid();
              if (grid && state.firstOnsetTimeSec !== null) {
                startTimeSec = nextDownbeatOnGrid(grid, state.firstOnsetTimeSec, nowSecForGrid, cfg.beatsPerBar, START_LEAD_SEC);
                clickBpm = clampClickBpm(gridBpm(grid));
              }
              stabilityTriggeredRef.current = true;
              triggerMetronomeStart(clickBpm, startTimeSec);
            }
          }
          return;
        }

        const previousState = barCountdownRef.current;

        // While our own count-in audio is playing, don't let it (if the mic
        // happens to pick up the device's own speaker output) feed back into
        // the tempo reading and corrupt or restart the countdown. Once
        // started, completion is purely time-based, so freezing the bpm
        // input here only prevents a feedback-driven drift-reset -- it
        // doesn't change when a genuine countdown finishes.
        const isCountInPlaying = countInEngineRef.current?.isRunning() ?? false;
        const bpmForCountdown =
          isCountInPlaying && previousState.lockStartBpm !== null
            ? previousState.lockStartBpm
            : state.continuity.displayedBpm;

        const result = updateBarCountdown(
          previousState,
          bpmForCountdown,
          performance.now() / 1000,
          { barsRequired: cfg.metronomeBars, beatsPerBar: cfg.beatsPerBar, startLeadSec: START_LEAD_SEC },
          state.firstOnsetTimeSec
        );
        barCountdownRef.current = result.state;

        if (result.state.lockStartTimeSec === null) {
          countInEngineRef.current?.stop();
        } else if (result.state.lockStartTimeSec !== previousState.lockStartTimeSec && !result.state.triggered) {
          countInEngineRef.current?.stop();
          if (cfg.countInEnabled && cfg.metronomeBars > 0 && result.state.lockStartBpm !== null) {
            if (!countInEngineRef.current) {
              countInEngineRef.current = new MetronomeEngine();
            }
            countInEngineRef.current.start(result.state.lockStartBpm, result.state.lockStartTimeSec, {
              beatsPerBar: cfg.beatsPerBar,
              accentMode: cfg.accentMode,
              backbeatCountInBars: cfg.backbeatCountInBars,
              customAccentBeats: parseCustomAccentBeats(cfg.customAccentBeatsInput, cfg.beatsPerBar),
              soundKit: cfg.soundKit,
              subdivision: cfg.subdivision,
              totalBars: cfg.metronomeBars,
              volumeScale: cfg.masterVolume * cfg.countInVolume,
              subdivisionVolumeScale: cfg.subdivisionVolume,
              timingOffsetMs: cfg.clickTimingOffsetMs,
            });
          }
        }

        if (result.shouldStartMetronome && result.metronomeBpm !== null && result.metronomeStartTimeSec !== null) {
          let clickBpm = result.metronomeBpm;
          let startTimeSec = result.metronomeStartTimeSec;
          // Refine (never redefine) the start using the fitted grid: same
          // count-in -- N bars after the first hit -- but timed from the
          // grid's phase and period instead of one hit plus the frozen
          // first-reading tempo. Only accepted if it agrees with the original
          // computation on WHICH beat this is (within half a beat); a
          // disagreement means something odd (e.g. the countdown restarted
          // mid-session), and the original answer is kept.
          const grid = freshGrid();
          if (grid && state.firstOnsetTimeSec !== null) {
            const gridStart = countInStartOnGrid(grid, state.firstOnsetTimeSec, cfg.metronomeBars, cfg.beatsPerBar);
            if (Math.abs(gridStart - startTimeSec) <= 0.5 * grid.periodSec) {
              startTimeSec = gridStart;
              clickBpm = clampClickBpm(gridBpm(grid));
            }
          }
          triggerMetronomeStart(clickBpm, startTimeSec);
        }

        // While a click track is already playing and the mic is still
        // listening, gently nudge its tempo toward whatever's currently
        // detected instead of leaving it running open-loop forever -- this
        // is what lets it track a live tempo that drifts slightly over the
        // course of a song rather than locking in one number for good.
        // Opt-in only: see liveTempoTrackingEnabled's doc comment for why.
        if (
          cfg.liveTempoTrackingEnabled &&
          !liveTrackingSuppressedRef.current &&
          metronomeEngineRef.current?.isRunning() &&
          state.continuity.displayedBpm !== null &&
          state.continuity.status !== 'finding'
        ) {
          metronomeEngineRef.current.updateBpm(state.continuity.displayedBpm);
        }
      },
    });
    return () => {
      engineRef.current?.stop();
      metronomeEngineRef.current?.stop();
      countInEngineRef.current?.stop();
      stopPositionPoll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.updateOptions(settings);
  }, [settings]);

  const prevMetronomeBarsRef = useRef(settings.metronomeBars);
  useEffect(() => {
    if (prevMetronomeBarsRef.current !== settings.metronomeBars) {
      prevMetronomeBarsRef.current = settings.metronomeBars;
      autoStartSuppressedRef.current = false; // changing the setting is a deliberate re-arm
      stopMetronomeInternal();
    }
  }, [settings.metronomeBars, stopMetronomeInternal]);

  const start = useCallback(() => {
    // Seed the mic detector's octave resolution with the current Tap
    // Tempo value, if any -- lets you establish the quarter note by tapping
    // it in before pressing Start Listening, rather than leaving the very
    // first mic-based read to guess the octave blind.
    engineRef.current?.start(tapState.bpm);
    // A genuinely new session starts its own fresh graph -- but stopping
    // (manually, or automatically once auto-start hands off to the click)
    // no longer clears it, so the last session's tempo history stays
    // visible for reference until a new one actually begins.
    setBpmHistory([]);
    lastGraphSampleRef.current = 0;
  }, [tapState.bpm]);

  /**
   * Restarts detection from scratch mid-session -- clears the current
   * lock/frozen state, tempo graph, and any auto-start progress, and
   * immediately starts listening again. For when the detected tempo has
   * drifted or locked onto the wrong thing and the fastest fix is a clean
   * re-acquire, without reaching for Stop then Start separately.
   */
  const resetListening = useCallback(() => {
    engineRef.current?.stop();
    engineRef.current?.start(tapState.bpm);
    setBpmHistory([]);
    lastGraphSampleRef.current = 0;
  }, [tapState.bpm]);

  // Auto-start listening as soon as the app opens and mic permission is
  // actually granted -- an "always listening" experience like other BPM
  // detector apps, rather than requiring an explicit first tap on Start
  // Listening every time. Runs once on mount; Stop Listening still works
  // as a normal manual override afterward.
  useEffect(() => {
    let cancelled = false;
    requestMicrophonePermissionEarly().then((granted) => {
      if (granted && !cancelled) {
        start();
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally mount-only
  }, []);

  const stop = useCallback(() => {
    engineRef.current?.stop();
  }, []);

  const tap = useCallback(() => {
    setTapState((prev) => registerTap(prev, performance.now() / 1000, { minBpm: settings.minBpm, maxBpm: settings.maxBpm }));
  }, [settings.minBpm, settings.maxBpm]);

  const resetTap = useCallback(() => {
    setTapState(createTapTempoState());
  }, []);

  const updateSettings = useCallback((partial: Partial<DetectorSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  }, []);

  /**
   * Re-syncs the running click to a tap on beat 1: the click's grid slides so
   * a downbeat lands exactly on the tap, without changing tempo. Pass the
   * pointer event's own timestamp -- it is stamped when the finger lands,
   * whereas a `click` event only fires on release, ~50-100ms later.
   */
  const syncClickToTap = useCallback((eventTimeStampMs?: number) => {
    const engine = metronomeEngineRef.current;
    if (!engine || !engine.isRunning()) return;
    const nowMs = performance.now();
    const result = engine.syncDownbeat(eventTimeToPerfSec(eventTimeStampMs ?? nowMs, nowMs));
    if (!result) return;
    const shiftMs = Math.round(result.shiftSec * 1000);
    setSyncFeedback(
      Math.abs(shiftMs) < 2
        ? 'Already on your beat -- that tap is now beat 1.'
        : `Re-synced: click moved ${Math.abs(shiftMs)} ms ${shiftMs > 0 ? 'later' : 'earlier'}, and that tap is now beat 1.`
    );
  }, []);

  /**
   * Measures the total fixed delay between when a click is scheduled and when
   * this device's own detector hears it -- mic latency, how the input is
   * timestamped, detector bias, and output/Bluetooth latency all at once --
   * and folds it into the click-timing offset. Plays 10 clicks through the
   * speaker while listening (see syncCalibration.ts for why that lag is
   * exactly the correction needed). Takes ~10 seconds, changes the setting
   * only on a trustworthy measurement, and otherwise says why it failed.
   */
  const calibrateSync = useCallback(async () => {
    if (calibratingRef.current) return;
    const cfg = settingsRef.current;
    if (!isMicrophoneSupported()) {
      setCalibration({ status: 'failed', message: "This browser can't use the microphone, so sync can't be measured." });
      return;
    }
    const engine = engineRef.current;
    if (!engine) return;

    calibratingRef.current = true;
    setCalibration({ status: 'running', message: "Measuring... keep the room quiet and don't touch the phone while 10 clicks play." });
    const testClick = new MetronomeEngine();
    try {
      // Take over from anything already running: a click already playing would
      // be indistinguishable from the test clicks, and a fresh listening
      // session gets a clean noise-floor calibration.
      metronomeEngineRef.current?.stop();
      countInEngineRef.current?.stop();
      setMetronomeActive(false);
      setMetronomeBpm(null);
      stopPositionPoll();
      engine.stop();
      await engine.start(null);
      if (engine.getStatus() !== 'listening') {
        setCalibration({
          status: 'failed',
          message: 'Microphone access is needed to measure sync. Allow it in your browser settings and try again.',
        });
        return;
      }

      const spacingSec = 60 / CAL_BPM;
      const startAtSec = performance.now() / 1000 + CAL_LEADIN_SEC;
      const scheduled = Array.from({ length: CAL_CLICKS }, (_, k) => startAtSec + k * spacingSec);
      // Recording mode low-passes the mic input at 150Hz to isolate a
      // kick/bass pulse from a full mix -- a woodblock's energy sits well
      // above that and would be filtered away, so the test signal has to
      // match whichever mode is actually listening. The kick kit's tone
      // sweeps 140Hz -> 42Hz, squarely inside what the filter passes.
      testClick.start(CAL_BPM, startAtSec, {
        beatsPerBar: 1,
        accentMode: 'all',
        soundKit: cfg.mode === 'recording' ? 'kick' : 'woodblock',
        subdivision: 'none',
        volumeScale: 1,
        subdivisionVolumeScale: 1,
        timingOffsetMs: cfg.clickTimingOffsetMs,
        totalBars: CAL_CLICKS,
      });
      await new Promise((resolve) => setTimeout(resolve, (CAL_LEADIN_SEC + CAL_CLICKS * spacingSec + CAL_TAIL_SEC) * 1000));

      const result = measureLoopbackLatency(scheduled, engine.getOnsetTimes());
      if (result.ok) {
        // The clicks were played with the current offset already applied, so
        // the measured lag is what's still missing on top of it.
        const measuredMs = Math.round(result.latencySec * 1000);
        const unclamped = cfg.clickTimingOffsetMs + measuredMs;
        const next = Math.max(-MAX_TIMING_OFFSET_MS, Math.min(MAX_TIMING_OFFSET_MS, unclamped));
        updateSettings({ clickTimingOffsetMs: next });
        setCalibration({
          status: 'done',
          message:
            `Measured ${measuredMs} ms of remaining delay (${result.matched} of ${result.total} clicks heard). ` +
            `Click timing is now ${next > 0 ? '+' : ''}${next} ms.` +
            (next !== unclamped ? ' (That hit the limit -- something unusual is adding a very large delay.)' : ''),
        });
      } else if (result.reason === 'too-few') {
        setCalibration({
          status: 'failed',
          message:
            `Only heard ${result.matched} of ${result.total} clicks. Use the phone's own speaker (headphones can't be ` +
            'picked up by the mic), turn the volume up, keep the room quiet, and try again. Nothing was changed.',
        });
      } else {
        setCalibration({
          status: 'failed',
          message:
            'The clicks were heard, but at inconsistent times -- likely room noise or an echo. Try again somewhere ' +
            'quieter. Nothing was changed.',
        });
      }
    } catch {
      setCalibration({ status: 'failed', message: 'Something went wrong while measuring. Nothing was changed -- try again.' });
    } finally {
      testClick.stop();
      engine.stop();
      calibratingRef.current = false;
    }
  }, [updateSettings, stopPositionPoll]);

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next);
  }, []);

  const setColorScheme = useCallback((next: ColorScheme) => {
    setColorSchemeState(next);
  }, []);

  const reorderSections = useCallback((fromIndex: number, toIndex: number) => {
    setSectionOrder((prev) => moveItem(prev, fromIndex, toIndex));
  }, []);

  const reorderMainSections = useCallback((fromIndex: number, toIndex: number) => {
    setMainSectionOrder((prev) => moveItem(prev, fromIndex, toIndex));
  }, []);

  const setManualBpm = useCallback(
    (bpm: number) => {
      setManualBpmState(Math.round(clampBpm(bpm)));
    },
    [clampBpm]
  );

  const halveManualBpm = useCallback(() => {
    setManualBpmState((prev) => Math.round(clampBpm(prev / 2)));
  }, [clampBpm]);

  const doubleManualBpm = useCallback(() => {
    setManualBpmState((prev) => Math.round(clampBpm(prev * 2)));
  }, [clampBpm]);

  /**
   * Fine tempo adjustment. While a click is running, nudges its live tempo
   * by an exact amount immediately (no restart); otherwise just adjusts
   * the pre-play dial. Either way, the dial value stays in sync so it's
   * correct if you later stop and restart.
   */
  const nudgeBpm = useCallback(
    (deltaBpm: number) => {
      if (metronomeActive) {
        liveTrackingSuppressedRef.current = true;
        metronomeEngineRef.current?.nudgeBpm(deltaBpm, settingsRef.current.minBpm, settingsRef.current.maxBpm);
      }
      setManualBpmState((prev) => Math.round(clampBpm(prev + deltaBpm)));
    },
    [metronomeActive, clampBpm]
  );

  /**
   * Fine phase adjustment for a running click -- shifts WHEN it plays
   * without touching tempo, for "right tempo, just not quite landing on
   * the beat" (which BPM nudging can't fix). Only meaningful while a
   * click is actually running, since there's no running timing to nudge
   * otherwise. Also nudges clickTimingOffsetMs by the same amount
   * (clamped to its usual +/-100ms range) so the correction carries
   * forward into the next auto-start too, not just this session's
   * already-running click.
   */
  const nudgePhase = useCallback(
    (deltaMs: number) => {
      if (!metronomeActive) return;
      metronomeEngineRef.current?.nudgePhase(deltaMs / 1000);
      updateSettings({
        clickTimingOffsetMs: Math.max(-MAX_TIMING_OFFSET_MS, Math.min(MAX_TIMING_OFFSET_MS, settingsRef.current.clickTimingOffsetMs + deltaMs)),
      });
    },
    [metronomeActive, updateSettings]
  );

  const playManualClick = useCallback(() => {
    const cfg = settingsRef.current;
    if (!metronomeEngineRef.current) {
      metronomeEngineRef.current = new MetronomeEngine();
    }
    barCountdownRef.current = createBarCountdownState();
    stabilityTriggeredRef.current = false;
    countInEngineRef.current?.stop();

    const ramp: TempoRampConfig | undefined = cfg.rampEnabled
      ? {
          startBpm: manualBpm,
          targetBpm: cfg.rampTargetBpm,
          bpmStep: cfg.rampBpmStep,
          barsPerStep: cfg.rampBarsPerStep,
          beatsPerBar: cfg.beatsPerBar,
        }
      : undefined;

    metronomeEngineRef.current.start(manualBpm, performance.now() / 1000, {
      beatsPerBar: cfg.beatsPerBar,
      accentMode: cfg.accentMode,
      backbeatCountInBars: cfg.backbeatCountInBars,
      customAccentBeats: parseCustomAccentBeats(cfg.customAccentBeatsInput, cfg.beatsPerBar),
      soundKit: cfg.soundKit,
      subdivision: cfg.subdivision,
      volumeScale: cfg.masterVolume,
      subdivisionVolumeScale: cfg.subdivisionVolume,
      timingOffsetMs: cfg.clickTimingOffsetMs,
      totalBars: cfg.clickTrackLengthBars,
      ramp,
      onFinished: () => {
        setMetronomeActive(false);
        setMetronomeBpm(null);
        setFeelState(1);
        liveTrackingSuppressedRef.current = false;
        stopPositionPoll();
      },
    });
    setMetronomeActive(true);
    setMetronomeBpm(manualBpm);
    setFeelState(1);
    liveTrackingSuppressedRef.current = false;
    startPositionPoll();
  }, [manualBpm, startPositionPoll, stopPositionPoll]);

  /** Live-toggles half/double-time feel on the currently running click track, without stopping or restarting it. */
  const setFeel = useCallback((next: FeelMultiplier) => {
    metronomeEngineRef.current?.setFeel(next);
    setFeelState(next);
  }, []);

  const currentPresetData = useCallback(
    (): SongPresetData => ({
      manualBpm,
      beatsPerBar: settingsRef.current.beatsPerBar,
      accentMode: settingsRef.current.accentMode,
      customAccentBeatsInput: settingsRef.current.customAccentBeatsInput,
      backbeatCountInBars: settingsRef.current.backbeatCountInBars,
      soundKit: settingsRef.current.soundKit,
      subdivision: settingsRef.current.subdivision,
      clickTrackLengthBars: settingsRef.current.clickTrackLengthBars,
      metronomeBars: settingsRef.current.metronomeBars,
    }),
    [manualBpm]
  );

  const savePresetAsNew = useCallback(
    (name: string) => {
      setPresets((prev) => addPreset(prev, name, currentPresetData(), Date.now()));
    },
    [currentPresetData]
  );

  const overwritePreset = useCallback(
    (id: string, name: string) => {
      setPresets((prev) => updatePreset(prev, id, name, currentPresetData(), Date.now()));
    },
    [currentPresetData]
  );

  const removePreset = useCallback((id: string) => {
    setPresets((prev) => deletePreset(prev, id));
  }, []);

  const loadPreset = useCallback(
    (id: string) => {
      const preset = findPreset(presets, id);
      if (!preset) return;
      setManualBpmState(preset.data.manualBpm);
      updateSettings({
        beatsPerBar: preset.data.beatsPerBar,
        accentMode: preset.data.accentMode,
        customAccentBeatsInput: preset.data.customAccentBeatsInput,
        backbeatCountInBars: preset.data.backbeatCountInBars,
        soundKit: preset.data.soundKit,
        subdivision: preset.data.subdivision,
        clickTrackLengthBars: preset.data.clickTrackLengthBars,
        metronomeBars: preset.data.metronomeBars,
      });
    },
    [presets, updateSettings]
  );

  return {
    settings,
    updateSettings,
    theme,
    setTheme,
    colorScheme,
    setColorScheme,
    sectionOrder,
    reorderSections,
    mainSectionOrder,
    reorderMainSections,
    engineState,
    bpmHistory,
    start,
    resetListening,
    calibrateSync,
    calibration,
    syncClickToTap,
    syncFeedback,
    stop,
    tapState,
    tap,
    resetTap,
    metronomeActive,
    metronomeBpm,
    metronomePosition,
    stopMetronome,
    manualBpm,
    setManualBpm,
    halveManualBpm,
    doubleManualBpm,
    nudgeBpm,
    nudgePhase,
    playManualClick,
    feel,
    setFeel,
    presets,
    savePresetAsNew,
    overwritePreset,
    removePreset,
    loadPreset,
    isMicrophoneSupported: isMicrophoneSupported(),
  };
}

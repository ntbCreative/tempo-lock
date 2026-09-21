import { useCallback, useEffect, useRef, useState } from 'react';
import { LiveTempoEngine, isMicrophoneSupported, type EngineState, type DetectionMode } from '../audio/liveTempoEngine';
import { MetronomeEngine, type MetronomePosition } from '../audio/metronomeEngine';
import { createContinuityState } from '../lib/continuity';
import {
  createBarCountdownState,
  updateBarCountdown,
  type BarCount,
  type BarCountdownState,
} from '../lib/metronomeSchedule';
import { parseCustomAccentBeats, type AccentMode, type SoundKit, type Subdivision } from '../lib/clickPattern';
import type { TempoRampConfig } from '../lib/tempoRamp';
import type { FeelMultiplier } from '../lib/feel';
import { createTapTempoState, registerTap, type TapTempoState } from '../lib/tapTempo';
import { parseStoredSettings, serializeSettings } from '../lib/settingsStorage';
import { moveItem } from '../lib/layoutOrder';
import { DEFAULT_THEME, type ThemeId } from '../lib/themes';
import { addPreset, updatePreset, deletePreset, findPreset, type Preset } from '../lib/presets';

const POSITION_POLL_MS = 100;

const SETTINGS_STORAGE_KEY = 'tempo-lock:settings';
const THEME_STORAGE_KEY = 'tempo-lock:theme';
const SECTION_ORDER_STORAGE_KEY = 'tempo-lock:section-order';
const PRESETS_STORAGE_KEY = 'tempo-lock:presets';

export type SettingsSectionId = 'detector' | 'clickTrack' | 'sounds' | 'practice' | 'appearance';

export const DEFAULT_SECTION_ORDER: SettingsSectionId[] = ['detector', 'clickTrack', 'sounds', 'practice', 'appearance'];

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
  clickTrackLengthBars: number;
  soundKit: SoundKit;
  /** Extra evenly-spaced ticks between the main beat clicks. */
  subdivision: Subdivision;
  /** Overall click track volume, 0-1. Applies to both auto-triggered and manual clicks; the count-in's own quieter volume is relative to this. */
  masterVolume: number;
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
  clickTrackLengthBars: 0,
  soundKit: 'digital',
  subdivision: 'none',
  masterVolume: 1,
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

export function useTempoDetector() {
  const [settings, setSettings] = useState<DetectorSettings>(() => loadInitial(SETTINGS_STORAGE_KEY, DEFAULT_SETTINGS));
  const [theme, setThemeState] = useState<ThemeId>(
    () => loadInitial(THEME_STORAGE_KEY, { theme: DEFAULT_THEME }).theme
  );
  const [sectionOrder, setSectionOrder] = useState<SettingsSectionId[]>(loadInitialSectionOrder);
  const [presets, setPresets] = useState<Preset<SongPresetData>[]>(
    () => loadInitial(PRESETS_STORAGE_KEY, { list: [] as Preset<SongPresetData>[] }).list
  );
  const [engineState, setEngineState] = useState<EngineState>({
    status: 'idle',
    continuity: createContinuityState(),
    signalLevel: 0,
    onsetCount: 0,
  });
  const [tapState, setTapState] = useState<TapTempoState>(createTapTempoState());
  const [metronomeActive, setMetronomeActive] = useState(false);
  const [metronomeBpm, setMetronomeBpm] = useState<number | null>(null);
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
    setMetronomeActive(false);
    setMetronomeBpm(null);
    setFeelState(1);
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
    window.localStorage.setItem(SECTION_ORDER_STORAGE_KEY, serializeSettings({ order: sectionOrder }));
  }, [sectionOrder]);

  useEffect(() => {
    window.localStorage.setItem(PRESETS_STORAGE_KEY, serializeSettings({ list: presets }));
  }, [presets]);

  // Volume applies live to whatever's currently playing -- no restart needed.
  useEffect(() => {
    metronomeEngineRef.current?.setVolumeScale(settings.masterVolume);
    countInEngineRef.current?.setVolumeScale(settings.masterVolume * settings.countInVolume);
  }, [settings.masterVolume, settings.countInVolume]);

  useEffect(() => {
    engineRef.current = new LiveTempoEngine({
      ...settings,
      onUpdate: (state) => {
        setEngineState(state);

        if (state.status !== 'listening') {
          if (metronomeEngineRef.current?.isRunning() || countInEngineRef.current?.isRunning()) {
            metronomeEngineRef.current?.stop();
            countInEngineRef.current?.stop();
            setMetronomeActive(false);
            setMetronomeBpm(null);
            stopPositionPoll();
          }
          barCountdownRef.current = createBarCountdownState();
          autoStartSuppressedRef.current = false; // a fresh session can always auto-start again
          return;
        }

        if (autoStartSuppressedRef.current) {
          // User explicitly stopped the click track this session: don't
          // silently restart it just because the tempo is still detected.
          return;
        }

        const cfg = settingsRef.current;
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
          { barsRequired: cfg.metronomeBars, beatsPerBar: cfg.beatsPerBar }
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
              customAccentBeats: parseCustomAccentBeats(cfg.customAccentBeatsInput, cfg.beatsPerBar),
              soundKit: cfg.soundKit,
              subdivision: cfg.subdivision,
              totalBars: cfg.metronomeBars,
              volumeScale: cfg.masterVolume * cfg.countInVolume,
            });
          }
        }

        if (result.shouldStartMetronome && result.metronomeBpm !== null && result.metronomeStartTimeSec !== null) {
          countInEngineRef.current?.stop();
          if (!metronomeEngineRef.current) {
            metronomeEngineRef.current = new MetronomeEngine();
          }
          metronomeEngineRef.current.start(result.metronomeBpm, result.metronomeStartTimeSec, {
            beatsPerBar: cfg.beatsPerBar,
            accentMode: cfg.accentMode,
            customAccentBeats: parseCustomAccentBeats(cfg.customAccentBeatsInput, cfg.beatsPerBar),
            soundKit: cfg.soundKit,
            subdivision: cfg.subdivision,
            volumeScale: cfg.masterVolume,
            totalBars: 0,
          });
          setMetronomeActive(true);
          setMetronomeBpm(result.metronomeBpm);
          setFeelState(1);
          startPositionPoll();
        }

        // While a click track is already playing and the mic is still
        // listening, gently nudge its tempo toward whatever's currently
        // detected instead of leaving it running open-loop forever -- this
        // is what lets it track a live tempo that drifts slightly over the
        // course of a song rather than locking in one number for good.
        // Opt-in only: see liveTempoTrackingEnabled's doc comment for why.
        if (
          cfg.liveTempoTrackingEnabled &&
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
  }, [tapState.bpm]);

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

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next);
  }, []);

  const reorderSections = useCallback((fromIndex: number, toIndex: number) => {
    setSectionOrder((prev) => moveItem(prev, fromIndex, toIndex));
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

  const playManualClick = useCallback(() => {
    const cfg = settingsRef.current;
    if (!metronomeEngineRef.current) {
      metronomeEngineRef.current = new MetronomeEngine();
    }
    barCountdownRef.current = createBarCountdownState();
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
      customAccentBeats: parseCustomAccentBeats(cfg.customAccentBeatsInput, cfg.beatsPerBar),
      soundKit: cfg.soundKit,
      subdivision: cfg.subdivision,
      volumeScale: cfg.masterVolume,
      totalBars: cfg.clickTrackLengthBars,
      ramp,
      onFinished: () => {
        setMetronomeActive(false);
        setMetronomeBpm(null);
        setFeelState(1);
        stopPositionPoll();
      },
    });
    setMetronomeActive(true);
    setMetronomeBpm(manualBpm);
    setFeelState(1);
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
    sectionOrder,
    reorderSections,
    engineState,
    start,
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

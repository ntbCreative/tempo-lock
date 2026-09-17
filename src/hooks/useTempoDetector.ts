import { useCallback, useEffect, useRef, useState } from 'react';
import { LiveTempoEngine, isMicrophoneSupported, type EngineState } from '../audio/liveTempoEngine';
import { MetronomeEngine, type MetronomePosition } from '../audio/metronomeEngine';
import { createContinuityState } from '../lib/continuity';
import {
  createBarCountdownState,
  updateBarCountdown,
  type BarCount,
  type BarCountdownState,
} from '../lib/metronomeSchedule';
import { parseCustomAccentBeats, type AccentMode, type SoundKit } from '../lib/clickPattern';
import { createTapTempoState, registerTap, type TapTempoState } from '../lib/tapTempo';
import { parseStoredSettings, serializeSettings } from '../lib/settingsStorage';
import { moveItem } from '../lib/layoutOrder';
import { DEFAULT_THEME, type ThemeId } from '../lib/themes';

const POSITION_POLL_MS = 100;

const SETTINGS_STORAGE_KEY = 'tempo-lock:settings';
const THEME_STORAGE_KEY = 'tempo-lock:theme';
const SECTION_ORDER_STORAGE_KEY = 'tempo-lock:section-order';

export type SettingsSectionId = 'detector' | 'clickTrack' | 'sounds' | 'appearance';

export const DEFAULT_SECTION_ORDER: SettingsSectionId[] = ['detector', 'clickTrack', 'sounds', 'appearance'];

export interface DetectorSettings {
  smoothing: number; // 0-1
  sensitivity: number; // 0-1
  minBpm: number;
  maxBpm: number;
  /** Start a click track after this many steady bars of lock; 0 disables the feature. */
  metronomeBars: BarCount;
  /** Time signature numerator: beats per bar. Applies to both the auto-start countdown and manual click track. */
  beatsPerBar: number;
  /** Which beats within a bar get accented/clapped. */
  accentMode: AccentMode;
  /** Raw text field for custom accent beats, e.g. "1,3" (1-indexed, comma-separated). */
  customAccentBeatsInput: string;
  /** Bars a manually-started click track should run for; 0 means "until stopped". */
  clickTrackLengthBars: number;
  /** Which synthesized percussion voice the click track uses. */
  soundKit: SoundKit;
}

export const DEFAULT_SETTINGS: DetectorSettings = {
  smoothing: 0.25,
  sensitivity: 0.5,
  minBpm: 40,
  maxBpm: 240,
  metronomeBars: 0,
  beatsPerBar: 4,
  accentMode: 'first',
  customAccentBeatsInput: '1',
  clickTrackLengthBars: 0,
  soundKit: 'digital',
};

function loadInitialSettings(): DetectorSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  return parseStoredSettings(window.localStorage.getItem(SETTINGS_STORAGE_KEY), DEFAULT_SETTINGS);
}

function loadInitialTheme(): ThemeId {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  return parseStoredSettings(window.localStorage.getItem(THEME_STORAGE_KEY), { theme: DEFAULT_THEME }).theme;
}

function loadInitialSectionOrder(): SettingsSectionId[] {
  if (typeof window === 'undefined') return DEFAULT_SECTION_ORDER;
  return parseStoredSettings(window.localStorage.getItem(SECTION_ORDER_STORAGE_KEY), { order: DEFAULT_SECTION_ORDER })
    .order;
}

export function useTempoDetector() {
  const [settings, setSettings] = useState<DetectorSettings>(loadInitialSettings);
  const [theme, setThemeState] = useState<ThemeId>(loadInitialTheme);
  const [sectionOrder, setSectionOrder] = useState<SettingsSectionId[]>(loadInitialSectionOrder);
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
  const [manualBpm, setManualBpmState] = useState(120);

  const engineRef = useRef<LiveTempoEngine | null>(null);
  const metronomeEngineRef = useRef<MetronomeEngine | null>(null);
  const barCountdownRef = useRef<BarCountdownState>(createBarCountdownState());
  const settingsRef = useRef(settings);
  const positionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const stopMetronome = useCallback(() => {
    metronomeEngineRef.current?.stop();
    barCountdownRef.current = createBarCountdownState();
    setMetronomeActive(false);
    setMetronomeBpm(null);
    stopPositionPoll();
  }, [stopPositionPoll]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Persist settings/theme/section order across reloads.
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
    engineRef.current = new LiveTempoEngine({
      ...settings,
      onUpdate: (state) => {
        setEngineState(state);

        if (state.status !== 'listening') {
          // Session isn't actively running: keep any click track and
          // countdown from a previous session from bleeding into the next.
          if (metronomeEngineRef.current?.isRunning()) {
            metronomeEngineRef.current.stop();
            setMetronomeActive(false);
            setMetronomeBpm(null);
            stopPositionPoll();
          }
          barCountdownRef.current = createBarCountdownState();
          return;
        }

        const cfg = settingsRef.current;
        const result = updateBarCountdown(
          barCountdownRef.current,
          state.continuity.status,
          state.continuity.displayedBpm,
          performance.now() / 1000,
          { barsRequired: cfg.metronomeBars, beatsPerBar: cfg.beatsPerBar }
        );
        barCountdownRef.current = result.state;

        if (result.shouldStartMetronome && result.metronomeBpm !== null && result.metronomeStartTimeSec !== null) {
          if (!metronomeEngineRef.current) {
            metronomeEngineRef.current = new MetronomeEngine();
          }
          metronomeEngineRef.current.start(result.metronomeBpm, result.metronomeStartTimeSec, {
            beatsPerBar: cfg.beatsPerBar,
            accentMode: cfg.accentMode,
            customAccentBeats: parseCustomAccentBeats(cfg.customAccentBeatsInput, cfg.beatsPerBar),
            soundKit: cfg.soundKit,
            totalBars: 0, // an auto-triggered click track runs until stopped, not a fixed length
          });
          setMetronomeActive(true);
          setMetronomeBpm(result.metronomeBpm);
          startPositionPoll();
        }
      },
    });
    return () => {
      engineRef.current?.stop();
      metronomeEngineRef.current?.stop();
      stopPositionPoll();
    };
    // Intentionally only constructed once; live setting changes go through updateOptions/refs below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.updateOptions(settings);
  }, [settings]);

  // Any change to the metronome-bars setting starts a clean countdown rather
  // than continuing to count toward a stale target.
  const prevMetronomeBarsRef = useRef(settings.metronomeBars);
  useEffect(() => {
    if (prevMetronomeBarsRef.current !== settings.metronomeBars) {
      prevMetronomeBarsRef.current = settings.metronomeBars;
      stopMetronome();
    }
  }, [settings.metronomeBars, stopMetronome]);

  const start = useCallback(() => {
    engineRef.current?.start();
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

  /** Manually start (or restart) a click track at `manualBpm`, independent of mic detection. */
  const playManualClick = useCallback(() => {
    const cfg = settingsRef.current;
    if (!metronomeEngineRef.current) {
      metronomeEngineRef.current = new MetronomeEngine();
    }
    barCountdownRef.current = createBarCountdownState();
    metronomeEngineRef.current.start(manualBpm, performance.now() / 1000, {
      beatsPerBar: cfg.beatsPerBar,
      accentMode: cfg.accentMode,
      customAccentBeats: parseCustomAccentBeats(cfg.customAccentBeatsInput, cfg.beatsPerBar),
      soundKit: cfg.soundKit,
      totalBars: cfg.clickTrackLengthBars,
      onFinished: () => {
        setMetronomeActive(false);
        setMetronomeBpm(null);
        stopPositionPoll();
      },
    });
    setMetronomeActive(true);
    setMetronomeBpm(manualBpm);
    startPositionPoll();
  }, [manualBpm, startPositionPoll, stopPositionPoll]);

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
    isMicrophoneSupported: isMicrophoneSupported(),
  };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { LiveTempoEngine, isMicrophoneSupported, type EngineState } from '../audio/liveTempoEngine';
import { MetronomeEngine } from '../audio/metronomeEngine';
import { createContinuityState } from '../lib/continuity';
import {
  createBarCountdownState,
  updateBarCountdown,
  type BarCount,
  type BarCountdownState,
} from '../lib/metronomeSchedule';
import { createTapTempoState, registerTap, type TapTempoState } from '../lib/tapTempo';

export interface DetectorSettings {
  smoothing: number; // 0-1
  sensitivity: number; // 0-1
  minBpm: number;
  maxBpm: number;
  /** Start a click track after this many steady bars of lock; 0 disables the feature. */
  metronomeBars: BarCount;
}

export const DEFAULT_SETTINGS: DetectorSettings = {
  smoothing: 0.25,
  sensitivity: 0.5,
  minBpm: 40,
  maxBpm: 240,
  metronomeBars: 0,
};

export function useTempoDetector() {
  const [settings, setSettings] = useState<DetectorSettings>(DEFAULT_SETTINGS);
  const [engineState, setEngineState] = useState<EngineState>({
    status: 'idle',
    continuity: createContinuityState(),
    signalLevel: 0,
    onsetCount: 0,
  });
  const [tapState, setTapState] = useState<TapTempoState>(createTapTempoState());
  const [metronomeActive, setMetronomeActive] = useState(false);
  const [metronomeBpm, setMetronomeBpm] = useState<number | null>(null);

  const engineRef = useRef<LiveTempoEngine | null>(null);
  const metronomeEngineRef = useRef<MetronomeEngine | null>(null);
  const barCountdownRef = useRef<BarCountdownState>(createBarCountdownState());
  const settingsRef = useRef(settings);

  const stopMetronome = useCallback(() => {
    metronomeEngineRef.current?.stop();
    barCountdownRef.current = createBarCountdownState();
    setMetronomeActive(false);
    setMetronomeBpm(null);
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

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
          { barsRequired: cfg.metronomeBars }
        );
        barCountdownRef.current = result.state;

        if (result.shouldStartMetronome && result.metronomeBpm !== null && result.metronomeStartTimeSec !== null) {
          if (!metronomeEngineRef.current) {
            metronomeEngineRef.current = new MetronomeEngine();
          }
          metronomeEngineRef.current.start(result.metronomeBpm, result.metronomeStartTimeSec, 4);
          setMetronomeActive(true);
          setMetronomeBpm(result.metronomeBpm);
        }
      },
    });
    return () => {
      engineRef.current?.stop();
      metronomeEngineRef.current?.stop();
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

  return {
    settings,
    updateSettings,
    engineState,
    start,
    stop,
    tapState,
    tap,
    resetTap,
    metronomeActive,
    metronomeBpm,
    stopMetronome,
    isMicrophoneSupported: isMicrophoneSupported(),
  };
}

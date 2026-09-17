import { useMemo } from 'react';
import { useTempoDetector } from './hooks/useTempoDetector';
import './App.css';

const RANGE_PRESETS: { label: string; min: number; max: number }[] = [
  { label: 'Full · 40–240', min: 40, max: 240 },
  { label: 'Ballad · 40–100', min: 40, max: 100 },
  { label: 'Mid · 80–160', min: 80, max: 160 },
  { label: 'Up-tempo · 140–240', min: 140, max: 240 },
];

const METRONOME_BAR_OPTIONS: { label: string; value: 0 | 1 | 2 | 4 }[] = [
  { label: 'Off', value: 0 },
  { label: 'After 1 bar', value: 1 },
  { label: 'After 2 bars', value: 2 },
  { label: 'After 4 bars', value: 4 },
];

function statusLabel(status: string, continuityStatus: string): string {
  switch (status) {
    case 'idle':
      return 'Stopped';
    case 'requesting-permission':
      return 'Requesting mic access…';
    case 'permission-denied':
      return 'Microphone permission denied';
    case 'unsupported':
      return 'Browser not supported';
    case 'error':
      return 'Something went wrong';
    case 'listening':
      if (continuityStatus === 'finding') return 'Finding tempo…';
      if (continuityStatus === 'low-confidence') return 'Weak / inconsistent signal';
      return 'Locked';
    default:
      return status;
  }
}

function App() {
  const {
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
    isMicrophoneSupported,
  } = useTempoDetector();

  const isListening = engineState.status === 'listening';
  const { continuity } = engineState;
  const label = statusLabel(engineState.status, continuity.status);

  const displayBpm = useMemo(() => {
    if (continuity.displayedBpm !== null) return Math.round(continuity.displayedBpm);
    if (tapState.bpm !== null) return Math.round(tapState.bpm);
    return null;
  }, [continuity.displayedBpm, tapState.bpm]);

  const statusClass = isListening
    ? continuity.status === 'locked'
      ? 'locked'
      : continuity.status === 'low-confidence'
      ? 'weak'
      : 'finding'
    : engineState.status === 'permission-denied' || engineState.status === 'unsupported' || engineState.status === 'error'
    ? 'weak'
    : 'idle';

  const confidencePercent = Math.round(Math.min(1, Math.max(0, continuity.confidence)) * 100);
  const signalPercent = Math.round(Math.min(1, Math.max(0, engineState.signalLevel)) * 100);

  return (
    <div className="stage">
      <header className="stage__header">
        <span className="stage__brand">TEMPO LOCK</span>
        <span className={`stage__status stage__status--${statusClass}`}>{label}</span>
      </header>

      <main className="stage__main">
        <div className="bpm-readout" role="status" aria-live="polite">
          <span className="bpm-readout__value">{displayBpm ?? '--'}</span>
          <span className="bpm-readout__unit">BPM</span>
        </div>

        <div className="meter-row">
          <div className="meter">
            <span className="meter__label">Confidence</span>
            <div className="meter__track">
              <div
                className={`meter__fill meter__fill--${statusClass}`}
                style={{ width: `${confidencePercent}%` }}
              />
            </div>
          </div>
          <div className="meter">
            <span className="meter__label">Signal</span>
            <div className="meter__track">
              <div className="meter__fill meter__fill--signal" style={{ width: `${signalPercent}%` }} />
            </div>
          </div>
        </div>

        {isListening && settings.metronomeBars > 0 && (
          <p className="notice notice--metronome">
            {metronomeActive
              ? `Click track running at ${metronomeBpm} BPM`
              : continuity.status === 'locked'
              ? `Counting in… click track starts after ${settings.metronomeBars} bar${settings.metronomeBars > 1 ? 's' : ''}`
              : 'Play steadily to start the count-in'}
          </p>
        )}

        {!isMicrophoneSupported && (
          <p className="notice notice--warning">
            This browser doesn't support live microphone tempo detection. Tap Tempo still works.
          </p>
        )}
        {engineState.status === 'permission-denied' && (
          <p className="notice notice--warning">
            Microphone access was denied. Allow microphone access in your browser settings, then try again.
          </p>
        )}

        <button
          type="button"
          className={`big-button ${isListening ? 'big-button--stop' : 'big-button--start'}`}
          onClick={isListening ? stop : start}
          disabled={!isMicrophoneSupported}
        >
          {isListening ? 'Stop Listening' : 'Start Listening'}
        </button>

        <button type="button" className="big-button big-button--tap" onClick={tap} onDoubleClick={resetTap}>
          Tap Tempo
        </button>

        {metronomeActive && (
          <button type="button" className="big-button big-button--stop-metronome" onClick={stopMetronome}>
            Stop Click Track
          </button>
        )}
      </main>

      <section className="controls" aria-label="Detector settings">
        <div className="control">
          <div className="control__label-row">
            <label htmlFor="smoothing">Smoothing</label>
            <span>{Math.round(settings.smoothing * 100)}%</span>
          </div>
          <input
            id="smoothing"
            type="range"
            min={0.05}
            max={0.6}
            step={0.01}
            value={settings.smoothing}
            onChange={(e) => updateSettings({ smoothing: Number(e.target.value) })}
          />
        </div>

        <div className="control">
          <div className="control__label-row">
            <label htmlFor="sensitivity">Input sensitivity</label>
            <span>{Math.round(settings.sensitivity * 100)}%</span>
          </div>
          <input
            id="sensitivity"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={settings.sensitivity}
            onChange={(e) => updateSettings({ sensitivity: Number(e.target.value) })}
          />
        </div>

        <div className="control">
          <div className="control__label-row">
            <label htmlFor="range">Tempo range</label>
          </div>
          <select
            id="range"
            value={`${settings.minBpm}-${settings.maxBpm}`}
            onChange={(e) => {
              const [min, max] = e.target.value.split('-').map(Number);
              updateSettings({ minBpm: min, maxBpm: max });
            }}
          >
            {RANGE_PRESETS.map((preset) => (
              <option key={preset.label} value={`${preset.min}-${preset.max}`}>
                {preset.label}
              </option>
            ))}
          </select>
        </div>
        <div className="control">
          <div className="control__label-row">
            <label htmlFor="metronome-bars">Click track</label>
          </div>
          <select
            id="metronome-bars"
            value={settings.metronomeBars}
            onChange={(e) => updateSettings({ metronomeBars: Number(e.target.value) as 0 | 1 | 2 | 4 })}
          >
            {METRONOME_BAR_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <footer className="stage__footer">
        <p className="privacy-note">
          Audio is processed live on this device only. Nothing is recorded, saved or uploaded.
        </p>
      </footer>
    </div>
  );
}

export default App;

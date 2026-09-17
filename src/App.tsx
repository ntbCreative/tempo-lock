import { useMemo } from 'react';
import { useTempoDetector } from './hooks/useTempoDetector';
import type { AccentMode } from './lib/clickPattern';
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

const SIGNATURE_OPTIONS: { label: string; beatsPerBar: number }[] = [
  { label: '2/4', beatsPerBar: 2 },
  { label: '3/4', beatsPerBar: 3 },
  { label: '4/4', beatsPerBar: 4 },
  { label: '5/4', beatsPerBar: 5 },
  { label: '6/8', beatsPerBar: 6 },
];

const ACCENT_MODE_OPTIONS: { label: string; value: AccentMode }[] = [
  { label: 'All beats', value: 'all' },
  { label: 'Accent 1', value: 'first' },
  { label: '2 & 4 clap', value: 'backbeat' },
  { label: 'Custom', value: 'custom' },
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
    metronomePosition,
    stopMetronome,
    manualBpm,
    setManualBpm,
    halveManualBpm,
    doubleManualBpm,
    playManualClick,
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

        {isListening && settings.metronomeBars > 0 && !metronomeActive && (
          <p className="notice notice--metronome">
            {continuity.status === 'locked'
              ? `Counting in… click track starts after ${settings.metronomeBars} bar${settings.metronomeBars > 1 ? 's' : ''}`
              : 'Play steadily to start the count-in'}
          </p>
        )}

        {metronomeActive && (
          <p className="notice notice--metronome">
            Click track at {metronomeBpm} BPM
            {metronomePosition && (
              <>
                {' · Bar '}
                {metronomePosition.barIndex + 1}
                {metronomePosition.remainingBars !== null && ` (${metronomePosition.remainingBars} left)`}
                {' · Beat '}
                {metronomePosition.beatInBar + 1}/{settings.beatsPerBar}
              </>
            )}
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
      </section>

      <section className="controls controls--click-track" aria-label="Click track settings">
        <h2 className="controls__heading">Click Track</h2>

        <div className="control">
          <div className="control__label-row">
            <label htmlFor="signature">Signature</label>
          </div>
          <select
            id="signature"
            value={settings.beatsPerBar}
            onChange={(e) => updateSettings({ beatsPerBar: Number(e.target.value) })}
          >
            {SIGNATURE_OPTIONS.map((option) => (
              <option key={option.label} value={option.beatsPerBar}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="control">
          <div className="control__label-row">
            <label htmlFor="accent-mode">Click mode</label>
          </div>
          <select
            id="accent-mode"
            value={settings.accentMode}
            onChange={(e) => updateSettings({ accentMode: e.target.value as AccentMode })}
          >
            {ACCENT_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {settings.accentMode === 'custom' && (
          <div className="control">
            <div className="control__label-row">
              <label htmlFor="custom-beats">Accent beats (1–{settings.beatsPerBar})</label>
            </div>
            <input
              id="custom-beats"
              type="text"
              inputMode="numeric"
              placeholder="e.g. 1, 3"
              value={settings.customAccentBeatsInput}
              onChange={(e) => updateSettings({ customAccentBeatsInput: e.target.value })}
            />
          </div>
        )}

        <div className="control">
          <div className="control__label-row">
            <label htmlFor="metronome-bars">Auto-start after</label>
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

        <div className="control">
          <div className="control__label-row">
            <label htmlFor="session-length">Manual session length</label>
            <span>{settings.clickTrackLengthBars === 0 ? 'Until stopped' : `${settings.clickTrackLengthBars} bars`}</span>
          </div>
          <input
            id="session-length"
            type="range"
            min={0}
            max={32}
            step={1}
            value={settings.clickTrackLengthBars}
            onChange={(e) => updateSettings({ clickTrackLengthBars: Number(e.target.value) })}
          />
        </div>

        <div className="manual-metronome">
          <div className="manual-metronome__bpm-row">
            <button type="button" className="pill-button" onClick={halveManualBpm} aria-label="Halve tempo">
              ½×
            </button>
            <div className="manual-metronome__bpm">
              <input
                type="number"
                min={settings.minBpm}
                max={settings.maxBpm}
                value={manualBpm}
                onChange={(e) => setManualBpm(Number(e.target.value))}
              />
              <span>BPM</span>
            </div>
            <button type="button" className="pill-button" onClick={doubleManualBpm} aria-label="Double tempo">
              2×
            </button>
          </div>
          <input
            type="range"
            min={settings.minBpm}
            max={settings.maxBpm}
            step={1}
            value={manualBpm}
            onChange={(e) => setManualBpm(Number(e.target.value))}
          />
          <button type="button" className="big-button big-button--manual-click" onClick={playManualClick}>
            Play Click
          </button>
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

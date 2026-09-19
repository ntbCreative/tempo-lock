import { useEffect, useMemo, useRef, useState } from 'react';
import { useTempoDetector } from './hooks/useTempoDetector';
import Settings from './Settings';
import './App.css';

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
    presets,
    savePresetAsNew,
    removePreset,
    loadPreset,
    isMicrophoneSupported,
  } = useTempoDetector();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const prevMetronomeActiveRef = useRef(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const isListening = engineState.status === 'listening';
  const { continuity } = engineState;
  const label = statusLabel(engineState.status, continuity.status);

  // Screen-reader announcements: the status label changes rarely enough to
  // announce every time (unlike the BPM number, which updates many times a
  // second and would be overwhelming to have read aloud continuously).
  useEffect(() => {
    setAnnouncement(label);
  }, [label]);

  useEffect(() => {
    if (metronomeActive && !prevMetronomeActiveRef.current) {
      setAnnouncement(`Click track started${metronomeBpm !== null ? ` at ${Math.round(metronomeBpm)} beats per minute` : ''}`);
    } else if (!metronomeActive && prevMetronomeActiveRef.current) {
      setAnnouncement('Click track stopped');
    }
    prevMetronomeActiveRef.current = metronomeActive;
  }, [metronomeActive, metronomeBpm]);

  const displayBpm = useMemo(() => {
    if (continuity.displayedBpm !== null) return continuity.displayedBpm.toFixed(1);
    if (tapState.bpm !== null) return tapState.bpm.toFixed(1);
    return null;
  }, [continuity.displayedBpm, tapState.bpm]);

  const bpmAriaLabel = displayBpm !== null ? `Current tempo: ${displayBpm} beats per minute` : 'No tempo detected yet';

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

  const clickTrackBpm = metronomePosition?.currentBpm ?? metronomeBpm;

  const handleSavePreset = () => {
    const name = newPresetName.trim();
    if (!name) return;
    savePresetAsNew(name);
    setNewPresetName('');
  };

  return (
    <div className="stage">
      <header className="stage__header">
        <span className="stage__brand">TEMPO LOCK</span>
        <div className="stage__header-right">
          <span className={`stage__status stage__status--${statusClass}`}>{label}</span>
          <button
            type="button"
            className="settings-toggle"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
          >
            ⚙
          </button>
        </div>
      </header>

      <main className="stage__main">
        <div className="sr-only" role="status" aria-live="polite">
          {announcement}
        </div>

        <div className="bpm-readout" role="group" aria-label={bpmAriaLabel}>
          <span className="bpm-readout__value" aria-hidden="true">
            {displayBpm ?? '--'}
          </span>
          <span className="bpm-readout__unit" aria-hidden="true">
            BPM
          </span>
          {metronomeActive && metronomePosition ? (
            <span
              key={`click-${metronomePosition.barIndex}-${metronomePosition.beatInBar}`}
              className="beat-pulse beat-pulse--flash"
              aria-hidden="true"
            />
          ) : continuity.status === 'locked' && continuity.displayedBpm ? (
            <span
              key={`tempo-${Math.round(continuity.displayedBpm)}`}
              className="beat-pulse beat-pulse--tempo"
              style={{ animationDuration: `${60000 / continuity.displayedBpm}ms` }}
              aria-hidden="true"
            />
          ) : (
            <span className="beat-pulse beat-pulse--idle" aria-hidden="true" />
          )}
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

        {isListening && continuity.status === 'finding' && (
          <p className="notice notice--diagnostic">{engineState.onsetCount} onsets detected</p>
        )}

        {isListening && settings.metronomeBars > 0 && !metronomeActive && (
          <p className="notice notice--metronome">
            {continuity.status === 'locked' || continuity.status === 'low-confidence'
              ? `Counting in… click track starts after ${settings.metronomeBars} bar${settings.metronomeBars > 1 ? 's' : ''}`
              : 'Play steadily to start the count-in'}
          </p>
        )}

        {metronomeActive && (
          <p className="notice notice--metronome">
            Click track at {clickTrackBpm !== null ? clickTrackBpm.toFixed(1) : '--'} BPM
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

        <div className="mode-toggle" role="group" aria-label="Detection mode">
          <button
            type="button"
            className="mode-toggle__option"
            data-active={settings.mode === 'live'}
            aria-pressed={settings.mode === 'live'}
            onClick={() => updateSettings({ mode: 'live' })}
            disabled={isListening}
          >
            Live
          </button>
          <button
            type="button"
            className="mode-toggle__option"
            data-active={settings.mode === 'recording'}
            aria-pressed={settings.mode === 'recording'}
            onClick={() => updateSettings({ mode: 'recording' })}
            disabled={isListening}
          >
            Recording
          </button>
        </div>
        <p className="settings-note mode-toggle__hint">
          {settings.mode === 'live'
            ? 'Tuned for sticks/kit hits.'
            : 'Tuned for a full song through speakers — isolates the kick/bass pulse.'}
        </p>

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

        <div className="manual-metronome">
          <div className="manual-metronome__bpm-row">
            <button type="button" className="pill-button" onClick={halveManualBpm} aria-label="Halve tempo">
              ½×
            </button>
            <div className="manual-metronome__bpm">
              <input
                type="number"
                aria-label="Manual tempo in beats per minute"
                min={settings.minBpm}
                max={settings.maxBpm}
                value={manualBpm}
                onChange={(e) => setManualBpm(Number(e.target.value))}
              />
              <span aria-hidden="true">BPM</span>
            </div>
            <button type="button" className="pill-button" onClick={doubleManualBpm} aria-label="Double tempo">
              2×
            </button>
          </div>
          <input
            type="range"
            aria-label="Manual tempo slider"
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

        <div className="setlist">
          <div className="setlist__save-row">
            <input
              type="text"
              className="setlist__name-input"
              aria-label="Preset name"
              placeholder="Save current setup as…"
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSavePreset();
              }}
            />
            <button
              type="button"
              className="pill-button"
              onClick={handleSavePreset}
              disabled={!newPresetName.trim()}
              aria-label="Save current setup as a new preset"
            >
              Save
            </button>
          </div>

          {presets.length > 0 && (
            <div className="setlist__chips">
              {presets.map((preset) => (
                <div key={preset.id} className="setlist__chip">
                  <button type="button" className="setlist__chip-name" onClick={() => loadPreset(preset.id)}>
                    {preset.name} · {preset.data.manualBpm} BPM
                  </button>
                  <button
                    type="button"
                    className="setlist__chip-remove"
                    onClick={() => removePreset(preset.id)}
                    aria-label={`Delete ${preset.name}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      <footer className="stage__footer">
        <p className="privacy-note">
          Audio is processed live on this device only. Nothing is recorded, saved or uploaded.
        </p>
      </footer>

      {settingsOpen && (
        <Settings
          settings={settings}
          updateSettings={updateSettings}
          theme={theme}
          setTheme={setTheme}
          sectionOrder={sectionOrder}
          reorderSections={reorderSections}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

export default App;

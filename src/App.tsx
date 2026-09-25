import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useTempoDetector } from './hooks/useTempoDetector';
import { doubleFeel, halveFeel } from './lib/feel';
import { ACCENT_MODE_OPTIONS, SUBDIVISION_OPTIONS, type AccentMode, type Subdivision } from './lib/clickPattern';
import { BAR_COUNT_OPTIONS, type BarCount } from './lib/metronomeSchedule';
import type { MainSectionId } from './hooks/useTempoDetector';
import Settings from './Settings';
import './App.css';

const MAIN_SECTION_TITLES: Record<MainSectionId, string> = {
  mode: 'Detection mode',
  start: 'Listen',
  tap: 'Tap tempo',
  click: 'Click track',
};

/** Formats a feel multiplier for display: 2 -> "2×", 0.5 -> "½×", 0.25 -> "¼×", 0.125 -> "⅛×". */
function formatFeel(feel: number): string {
  if (feel === 1) return '1×';
  if (feel < 1) {
    const denominator = Math.round(1 / feel);
    const fractionGlyphs: Record<number, string> = { 2: '½', 4: '¼', 8: '⅛' };
    return `${fractionGlyphs[denominator] ?? `1/${denominator}`}×`;
  }
  return `${feel}×`;
}

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
    colorScheme,
    setColorScheme,
    sectionOrder,
    reorderSections,
    mainSectionOrder,
    reorderMainSections,
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
    nudgeBpm,
    nudgePhase,
    feel,
    setFeel,
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
  const [mainDraggingIndex, setMainDraggingIndex] = useState<number | null>(null);
  // Remembers the last non-"Off" auto-start choice (bars or "Once stable"),
  // so toggling Auto-start click off and back on restores what was picked
  // rather than always resetting to a fixed default.
  const [lastAutoStartBars, setLastAutoStartBars] = useState<Exclude<BarCount, 0>>(
    settings.metronomeBars !== 0 ? settings.metronomeBars : 2
  );
  const [justLocked, setJustLocked] = useState(false);
  const prevMetronomeActiveRef = useRef(false);

  useEffect(() => {
    if (settings.metronomeBars !== 0) {
      setLastAutoStartBars(settings.metronomeBars);
    }
  }, [settings.metronomeBars]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-scheme', colorScheme);
  }, [colorScheme]);

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

  // A brief celebratory flourish the moment detection actually locks in --
  // makes that moment feel rewarding, not just informational. Only fires
  // on the transition into 'locked', not on every render while locked.
  const prevContinuityStatusRef = useRef(continuity.status);
  useEffect(() => {
    if (continuity.status === 'locked' && prevContinuityStatusRef.current !== 'locked') {
      setJustLocked(true);
      const timeout = setTimeout(() => setJustLocked(false), 550);
      prevContinuityStatusRef.current = continuity.status;
      return () => clearTimeout(timeout);
    }
    prevContinuityStatusRef.current = continuity.status;
  }, [continuity.status]);

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

        <section className="stage__hero">
        <div className="bpm-readout" role="group" aria-label={bpmAriaLabel} data-just-locked={justLocked}>
          {metronomeActive && metronomePosition ? (
            <span
              key={`click-${metronomePosition.barIndex}-${metronomePosition.beatInBar}`}
              className="bpm-readout__ring bpm-readout__ring--flash"
              aria-hidden="true"
            />
          ) : continuity.status === 'locked' && continuity.displayedBpm ? (
            <span
              key={`tempo-${Math.round(continuity.displayedBpm)}`}
              className="bpm-readout__ring bpm-readout__ring--pulse"
              style={{ animationDuration: `${60000 / continuity.displayedBpm}ms` }}
              aria-hidden="true"
            />
          ) : null}
          <span className="bpm-readout__value" aria-hidden="true">
            {displayBpm ?? '--'}
          </span>
          <span className="bpm-readout__unit" aria-hidden="true">
            BPM
          </span>
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

        {isListening && (
          <details className="diagnostics-disclosure">
            <summary>Diagnostics</summary>
            <p className="notice notice--diagnostic">
              {engineState.onsetCount} onsets · {confidencePercent}% confidence · {signalPercent}% signal
              {engineState.candidates.length > 0 && (
                <>
                  {' · candidates: '}
                  {engineState.candidates
                    .map((c) => `${Math.round(c.bpm)} (${Math.round(c.score * 100)}%, n=${c.supportCount})`)
                    .join(', ')}
                </>
              )}
            </p>
          </details>
        )}

        {isListening && settings.metronomeBars > 0 && !metronomeActive && (
          <p className="notice notice--metronome">
            {continuity.status === 'locked' || continuity.status === 'low-confidence'
              ? `Counting in… click track starts after ${settings.metronomeBars} bar${settings.metronomeBars > 1 ? 's' : ''}`
              : 'Play steadily to start the count-in'}
          </p>
        )}

        {isListening && settings.metronomeBars === -1 && !metronomeActive && (
          <p className="notice notice--metronome">
            {continuity.status === 'locked' || continuity.status === 'low-confidence'
              ? 'Waiting for a steady, consistent tempo before starting the click…'
              : 'Play steadily to start the click'}
          </p>
        )}

        {metronomeActive && (
          <p className="notice notice--metronome">
            Click track at {clickTrackBpm !== null ? clickTrackBpm.toFixed(1) : '--'} BPM
            {feel !== 1 && ` (${formatFeel(feel)} feel)`}
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

        {engineState.frozen && (
          <p className="notice notice--locked">🔒 Locked for this session — won't re-detect until you stop listening</p>
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

        {(() => {
          const mainSectionContent: Record<MainSectionId, ReactElement> = {
            mode: (
              <>
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

                <div className="control auto-start-control">
                  <div className="control__label-row">
                    <label htmlFor="auto-start-toggle">Auto-start click</label>
                    <input
                      id="auto-start-toggle"
                      type="checkbox"
                      checked={settings.metronomeBars !== 0}
                      onChange={(e) =>
                        updateSettings({ metronomeBars: e.target.checked ? lastAutoStartBars : 0 })
                      }
                    />
                  </div>
                  <p className="settings-note">
                    {settings.metronomeBars === 0
                      ? 'Off: just shows the detected BPM — the click never starts on its own.'
                      : 'On: the click track starts automatically once detection meets the condition below.'}
                  </p>
                  {settings.metronomeBars !== 0 && (
                    <select
                      id="metronome-bars-main"
                      value={settings.metronomeBars}
                      onChange={(e) => updateSettings({ metronomeBars: Number(e.target.value) as BarCount })}
                    >
                      {BAR_COUNT_OPTIONS.filter((option) => option.value !== 0).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </>
            ),
            start: (
              <button
                type="button"
                className={`big-button ${isListening ? 'big-button--stop' : 'big-button--start'}`}
                onClick={isListening ? stop : start}
                disabled={!isMicrophoneSupported}
              >
                {isListening ? 'Stop Listening' : 'Start Listening'}
              </button>
            ),
            tap: (
              <button type="button" className="big-button big-button--tap" onClick={tap} onDoubleClick={resetTap}>
                Tap Tempo
              </button>
            ),
            click: (
              <div className="manual-metronome">
                <div className="control click-mode-control">
                  <div className="control__label-row">
                    <label htmlFor="accent-mode-main">Click mode</label>
                  </div>
                  <select
                    id="accent-mode-main"
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

                <div className="control click-mode-control">
                  <div className="control__label-row">
                    <label htmlFor="subdivision-main">Subdivision</label>
                  </div>
                  <select
                    id="subdivision-main"
                    value={settings.subdivision}
                    onChange={(e) => updateSettings({ subdivision: e.target.value as Subdivision })}
                  >
                    {SUBDIVISION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                {settings.accentMode === 'backbeat' && (
                  <div className="control click-mode-control">
                    <div className="control__label-row">
                      <label htmlFor="backbeat-count-in-main">Count-in before the clap starts</label>
                    </div>
                    <select
                      id="backbeat-count-in-main"
                      value={settings.backbeatCountInBars}
                      onChange={(e) => updateSettings({ backbeatCountInBars: Number(e.target.value) as 0 | 1 | 2 })}
                    >
                      <option value={0}>Off</option>
                      <option value={1}>1 bar of straight quarters</option>
                      <option value={2}>2 bars of straight quarters</option>
                    </select>
                  </div>
                )}

                <hr className="manual-metronome__divider" />

                <div className="manual-metronome__bpm-row">
                  <button
                    type="button"
                    className="pill-button"
                    onClick={metronomeActive ? () => setFeel(halveFeel(feel)) : halveManualBpm}
                    aria-label={metronomeActive ? 'Halve click rate' : 'Halve tempo'}
                    aria-pressed={metronomeActive ? feel < 1 : undefined}
                    data-active={metronomeActive && feel < 1}
                  >
                    ½×
                  </button>
                  <div className="manual-metronome__bpm">
                    {metronomeActive ? (
                      <span className="manual-metronome__bpm-live" aria-label="Current click tempo in beats per minute">
                        {clickTrackBpm !== null ? clickTrackBpm.toFixed(1) : manualBpm}
                      </span>
                    ) : (
                      <input
                        type="number"
                        aria-label="Manual tempo in beats per minute"
                        min={settings.minBpm}
                        max={settings.maxBpm}
                        value={manualBpm}
                        onChange={(e) => setManualBpm(Number(e.target.value))}
                      />
                    )}
                    <span aria-hidden="true">BPM</span>
                  </div>
                  <button
                    type="button"
                    className="pill-button"
                    onClick={metronomeActive ? () => setFeel(doubleFeel(feel)) : doubleManualBpm}
                    aria-label={metronomeActive ? 'Double click rate' : 'Double tempo'}
                    aria-pressed={metronomeActive ? feel > 1 : undefined}
                    data-active={metronomeActive && feel > 1}
                  >
                    2×
                  </button>
                </div>
                <div className="manual-metronome__nudge-row">
                  <button
                    type="button"
                    className="pill-button pill-button--nudge"
                    onClick={() => nudgeBpm(-1)}
                    aria-label="Decrease tempo by 1 BPM"
                  >
                    −1 BPM
                  </button>
                  <button
                    type="button"
                    className="pill-button pill-button--nudge"
                    onClick={() => nudgeBpm(1)}
                    aria-label="Increase tempo by 1 BPM"
                  >
                    +1 BPM
                  </button>
                </div>
                {metronomeActive && (
                  <>
                    <div className="manual-metronome__nudge-row">
                      <button
                        type="button"
                        className="pill-button pill-button--nudge"
                        onClick={() => nudgePhase(-25)}
                        aria-label="Shift click 25 milliseconds earlier"
                      >
                        ◂ Earlier
                      </button>
                      <button
                        type="button"
                        className="pill-button pill-button--nudge"
                        onClick={() => nudgePhase(25)}
                        aria-label="Shift click 25 milliseconds later"
                      >
                        Later ▸
                      </button>
                    </div>
                    <p className="settings-note" style={{ textAlign: 'center', marginTop: -4 }} aria-live="polite">
                      Timing: {settings.clickTimingOffsetMs === 0 ? 'on time' : `${settings.clickTimingOffsetMs > 0 ? '+' : ''}${settings.clickTimingOffsetMs}ms`}
                      {' · takes effect within about a beat, not instantly'}
                    </p>
                  </>
                )}
                {metronomeActive && (
                  <p className="settings-note" style={{ textAlign: 'center', marginTop: -4 }}>
                    {feel === 1
                      ? 'Tap ½× or 2× to change feel live — each press doubles or halves again.'
                      : `${formatFeel(feel)} feel active — same tempo underneath.`}
                  </p>
                )}
                <input
                  type="range"
                  aria-label="Manual tempo slider"
                  min={settings.minBpm}
                  max={settings.maxBpm}
                  step={1}
                  value={manualBpm}
                  onChange={(e) => setManualBpm(Number(e.target.value))}
                />
                <button
                  type="button"
                  className={`big-button ${metronomeActive ? 'big-button--stop-metronome' : 'big-button--manual-click'}`}
                  onClick={metronomeActive ? stopMetronome : playManualClick}
                >
                  {metronomeActive ? 'Stop Click' : 'Play Click'}
                </button>
              </div>
            ),
          };

          return mainSectionOrder.map((id, index) => (
            <div
              key={id}
              className="main-section"
              data-dragging={mainDraggingIndex === index}
              draggable
              onDragStart={() => setMainDraggingIndex(index)}
              onDragEnd={() => setMainDraggingIndex(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (mainDraggingIndex !== null && mainDraggingIndex !== index) {
                  reorderMainSections(mainDraggingIndex, index);
                }
                setMainDraggingIndex(null);
              }}
            >
              <div className="main-section__handle">
                <span className="main-section__grip" aria-hidden="true">
                  ⠿
                </span>
                <span className="main-section__title">{MAIN_SECTION_TITLES[id]}</span>
                <div className="main-section__reorder">
                  <button
                    type="button"
                    className="settings-section__reorder-btn"
                    onClick={() => reorderMainSections(index, index - 1)}
                    disabled={index === 0}
                    aria-label={`Move ${MAIN_SECTION_TITLES[id]} up`}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    className="settings-section__reorder-btn"
                    onClick={() => reorderMainSections(index, index + 1)}
                    disabled={index === mainSectionOrder.length - 1}
                    aria-label={`Move ${MAIN_SECTION_TITLES[id]} down`}
                  >
                    ▼
                  </button>
                </div>
              </div>
              <div className="main-section__body">{mainSectionContent[id]}</div>
            </div>
          ));
        })()}
        </section>

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
          colorScheme={colorScheme}
          setColorScheme={setColorScheme}
          sectionOrder={sectionOrder}
          reorderSections={reorderSections}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

export default App;

import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { DetectorSettings, SettingsSectionId } from './hooks/useTempoDetector';
import type { SoundKit } from './lib/clickPattern';
import { SOUND_KITS } from './lib/clickPattern';
import { THEMES, type ThemeId } from './lib/themes';
import { createSilentWavDataUri } from './audio/silentAudio';

const RANGE_PRESETS: { label: string; min: number; max: number }[] = [
  { label: 'Full · 40–240', min: 40, max: 240 },
  { label: 'Ballad · 40–100', min: 40, max: 100 },
  { label: 'Mid · 80–160', min: 80, max: 160 },
  { label: 'Up-tempo · 140–240', min: 140, max: 240 },
];

const SIGNATURE_OPTIONS: { label: string; beatsPerBar: number }[] = [
  { label: '2/4', beatsPerBar: 2 },
  { label: '3/4', beatsPerBar: 3 },
  { label: '4/4', beatsPerBar: 4 },
  { label: '5/4', beatsPerBar: 5 },
  { label: '6/8', beatsPerBar: 6 },
];

const SECTION_TITLES: Record<SettingsSectionId, string> = {
  detector: 'Detector',
  clickTrack: 'Click Track',
  sounds: 'Sounds',
  practice: 'Practice',
  appearance: 'Appearance',
};

interface SettingsProps {
  settings: DetectorSettings;
  updateSettings: (partial: Partial<DetectorSettings>) => void;
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  sectionOrder: SettingsSectionId[];
  reorderSections: (fromIndex: number, toIndex: number) => void;
  onClose: () => void;
}

function DetectorSection({ settings, updateSettings }: SettingsProps) {
  return (
    <div className="settings-section__body">
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
        <p className="settings-note">
          Lower: reacts fast to real tempo changes, but a single mistimed hit can make the number jump. Higher:
          steadier, slower to react — better for a solid, locked-in pulse than loose or expressive playing.
        </p>
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
        <p className="settings-note">
          Lower: only strong, solid hits register — good for a firm, consistent pulse. Higher: catches quieter
          hits too (ghost notes, grace notes), but picks up more background noise along with them.
        </p>
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
    </div>
  );
}

function ClickTrackSection({ settings, updateSettings }: SettingsProps) {
  return (
    <div className="settings-section__body">
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

      <p className="settings-note">Click mode itself now lives on the main screen, next to the click controls.</p>

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

      {settings.accentMode === 'backbeat' && (
        <p className="settings-note">
          "Count-in before the clap starts" now lives on the main screen, next to Click mode.
        </p>
      )}

      <p className="settings-note">Auto-start after now lives on the main screen too, next to the click controls.</p>

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

      <div className="control">
        <div className="control__label-row">
          <label htmlFor="count-in">Audible count-in</label>
          <input
            id="count-in"
            type="checkbox"
            checked={settings.countInEnabled}
            onChange={(e) => updateSettings({ countInEnabled: e.target.checked })}
          />
        </div>
        <p className="settings-note">
          Plays quiet clicks during the auto-start countdown bars, so the band hears it coming.
        </p>
        {settings.countInEnabled && (
          <>
            <div className="control__label-row" style={{ marginTop: 10 }}>
              <label htmlFor="count-in-volume">Count-in volume</label>
              <span>{Math.round(settings.countInVolume * 100)}%</span>
            </div>
            <input
              id="count-in-volume"
              type="range"
              min={0.1}
              max={0.8}
              step={0.05}
              value={settings.countInVolume}
              onChange={(e) => updateSettings({ countInVolume: Number(e.target.value) })}
            />
          </>
        )}
      </div>
    </div>
  );
}

function SoundsSection({ settings, updateSettings }: SettingsProps) {
  return (
    <div className="settings-section__body">
      <div className="control">
        <div className="control__label-row">
          <label htmlFor="master-volume">Click volume</label>
          <span>{Math.round(settings.masterVolume * 100)}%</span>
        </div>
        <input
          id="master-volume"
          type="range"
          min={0.2}
          max={1}
          step={0.02}
          value={settings.masterVolume}
          onChange={(e) => updateSettings({ masterVolume: Number(e.target.value) })}
        />
        <p className="settings-note">Applies live, even while a click is already playing.</p>
      </div>

      <div className="control">
        <div className="control__label-row">
          <label htmlFor="timing-offset">Click timing</label>
          <span>
            {settings.clickTimingOffsetMs === 0
              ? 'On time'
              : `${settings.clickTimingOffsetMs > 0 ? '+' : ''}${settings.clickTimingOffsetMs}ms`}
          </span>
        </div>
        <input
          id="timing-offset"
          type="range"
          min={-100}
          max={100}
          step={5}
          value={settings.clickTimingOffsetMs}
          onChange={(e) => updateSettings({ clickTimingOffsetMs: Number(e.target.value) })}
        />
        <p className="settings-note">
          The app already auto-compensates for the delay between scheduling a click and it actually reaching your
          speakers, where the browser can measure it. Bluetooth speakers and headphones often add real delay the
          browser can't see at all. If the click sounds slightly late (displaced) against what you're playing,
          raise this. If it sounds early, lower it.
        </p>
      </div>

      <div className="control">
        <div className="control__label-row">
          <label htmlFor="sound-kit">Click sound</label>
        </div>
        <select
          id="sound-kit"
          value={settings.soundKit}
          onChange={(e) => updateSettings({ soundKit: e.target.value as SoundKit })}
        >
          {SOUND_KITS.map((kit) => (
            <option key={kit.value} value={kit.value}>
              {kit.label}
            </option>
          ))}
        </select>
        <p className="settings-note">
          {settings.soundKit === 'digital'
            ? '2 & 4 clap mode uses a dedicated clap sound.'
            : '2 & 4 clap mode plays this sound, accented, on beats 2 and 4.'}
        </p>
      </div>

      <p className="settings-note">Subdivision now lives on the main screen too, next to the click controls.</p>
    </div>
  );
}

function PracticeSection({ settings, updateSettings }: SettingsProps) {
  return (
    <div className="settings-section__body">
      <div className="control">
        <div className="control__label-row">
          <label htmlFor="ramp-enabled">Tempo ramp</label>
          <input
            id="ramp-enabled"
            type="checkbox"
            checked={settings.rampEnabled}
            onChange={(e) => updateSettings({ rampEnabled: e.target.checked })}
          />
        </div>
        <p className="settings-note">
          When on, Play Click starts at the dialed-in BPM and steps up (or down) toward a target as you play,
          instead of staying fixed. Classic speed-building practice.
        </p>
      </div>

      {settings.rampEnabled && (
        <>
          <div className="control">
            <div className="control__label-row">
              <label htmlFor="ramp-target">Target BPM</label>
              <span>{settings.rampTargetBpm}</span>
            </div>
            <input
              id="ramp-target"
              type="range"
              min={settings.minBpm}
              max={settings.maxBpm}
              step={1}
              value={settings.rampTargetBpm}
              onChange={(e) => updateSettings({ rampTargetBpm: Number(e.target.value) })}
            />
          </div>

          <div className="control">
            <div className="control__label-row">
              <label htmlFor="ramp-step">BPM step</label>
              <span>+{settings.rampBpmStep}</span>
            </div>
            <input
              id="ramp-step"
              type="range"
              min={1}
              max={20}
              step={1}
              value={settings.rampBpmStep}
              onChange={(e) => updateSettings({ rampBpmStep: Number(e.target.value) })}
            />
          </div>

          <div className="control">
            <div className="control__label-row">
              <label htmlFor="ramp-bars">Bars per step</label>
              <span>{settings.rampBarsPerStep}</span>
            </div>
            <input
              id="ramp-bars"
              type="range"
              min={1}
              max={16}
              step={1}
              value={settings.rampBarsPerStep}
              onChange={(e) => updateSettings({ rampBarsPerStep: Number(e.target.value) })}
            />
          </div>
        </>
      )}

      <div className="control">
        <div className="control__label-row">
          <label htmlFor="live-tracking">Live tempo tracking</label>
          <input
            id="live-tracking"
            type="checkbox"
            checked={settings.liveTempoTrackingEnabled}
            onChange={(e) => updateSettings({ liveTempoTrackingEnabled: e.target.checked })}
          />
        </div>
        <p className="settings-note">
          While a click plays and the mic is still listening, gently track ongoing drift in the detected tempo.
          Off by default: if your speaker output reaches its own mic, the click can start hearing itself and
          drifting on its own. Safe to enable with headphones or an isolated mic.
        </p>
      </div>
    </div>
  );
}

function AppearanceSection({ theme, setTheme }: SettingsProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [airplaySupported, setAirplaySupported] = useState(false);
  const [silentSrc] = useState(createSilentWavDataUri);

  useEffect(() => {
    const el = audioRef.current as (HTMLAudioElement & { webkitShowPlaybackTargetPicker?: () => void }) | null;
    setAirplaySupported(!!el && typeof el.webkitShowPlaybackTargetPicker === 'function');
  }, []);

  const showAirplayPicker = () => {
    const el = audioRef.current as (HTMLAudioElement & { webkitShowPlaybackTargetPicker?: () => void }) | null;
    el?.play().catch(() => undefined);
    el?.webkitShowPlaybackTargetPicker?.();
  };

  return (
    <div className="settings-section__body">
      <div className="control">
        <div className="control__label-row">
          <span id="theme-group-label">Color theme</span>
        </div>
        <div className="theme-swatches" role="group" aria-labelledby="theme-group-label">
          {THEMES.map((option) => (
            <button
              key={option.id}
              type="button"
              className="theme-swatch"
              data-active={theme === option.id}
              aria-pressed={theme === option.id}
              style={{ background: option.swatch }}
              aria-label={option.label}
              onClick={() => setTheme(option.id)}
            />
          ))}
        </div>
      </div>

      <div className="control">
        <div className="control__label-row">
          <span>AirPlay</span>
        </div>
        {airplaySupported ? (
          <button type="button" className="airplay-button" onClick={showAirplayPicker}>
            Choose Speaker or AirPlay Device
          </button>
        ) : (
          <p className="settings-note">
            The in-app AirPlay picker only works in Safari on Apple devices. On other browsers, route audio to
            AirPlay/Bluetooth speakers from your device's system audio controls instead — it works the same way,
            just outside the app.
          </p>
        )}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio ref={audioRef} src={silentSrc} muted playsInline style={{ display: 'none' }} />
      </div>
    </div>
  );
}

const SECTION_RENDERERS: Record<SettingsSectionId, (props: SettingsProps) => ReactElement> = {
  detector: DetectorSection,
  clickTrack: ClickTrackSection,
  sounds: SoundsSection,
  practice: PracticeSection,
  appearance: AppearanceSection,
};

export default function Settings(props: SettingsProps) {
  const { sectionOrder, reorderSections, onClose } = props;
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-panel__header">
          <span id="settings-title" className="settings-panel__title">
            Settings
          </span>
          <button type="button" className="settings-panel__close" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </div>
        <p className="settings-note">Drag a section's handle to reorder it, or use the arrow buttons.</p>

        {sectionOrder.map((sectionId, index) => {
          const Renderer = SECTION_RENDERERS[sectionId];
          const title = SECTION_TITLES[sectionId];
          return (
            <div
              key={sectionId}
              className="settings-section"
              data-dragging={draggingIndex === index}
              draggable
              onDragStart={() => setDraggingIndex(index)}
              onDragEnd={() => setDraggingIndex(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (draggingIndex !== null && draggingIndex !== index) {
                  reorderSections(draggingIndex, index);
                }
                setDraggingIndex(null);
              }}
            >
              <div className="settings-section__handle">
                <span className="settings-section__grip" aria-hidden="true">
                  ⠿
                </span>
                <span className="settings-section__title">{title}</span>
                <div className="settings-section__reorder">
                  <button
                    type="button"
                    className="settings-section__reorder-btn"
                    onClick={() => reorderSections(index, index - 1)}
                    disabled={index === 0}
                    aria-label={`Move ${title} section up`}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    className="settings-section__reorder-btn"
                    onClick={() => reorderSections(index, index + 1)}
                    disabled={index === sectionOrder.length - 1}
                    aria-label={`Move ${title} section down`}
                  >
                    ▼
                  </button>
                </div>
              </div>
              <Renderer {...props} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

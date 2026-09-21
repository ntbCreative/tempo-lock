/**
 * Which sound a given beat within a bar should play, based on the chosen
 * accent mode. Pure and independent of both the scheduler and the audio
 * synthesis, so the pattern logic can be tested on its own.
 */

export type AccentMode = 'all' | 'first' | 'backbeat' | 'custom';

export const ACCENT_MODE_OPTIONS: { label: string; value: AccentMode }[] = [
  { label: 'All beats', value: 'all' },
  { label: 'Accent 1', value: 'first' },
  { label: '2 & 4 clap', value: 'backbeat' },
  { label: 'Custom', value: 'custom' },
];

export type ClickSound = 'accent' | 'normal' | 'clap' | 'mute';

export interface ClickPatternConfig {
  accentMode: AccentMode;
  beatsPerBar: number;
  /** For 'custom' mode only: zero-indexed beat positions within the bar that get an accent click; every other beat plays a normal click. */
  customAccentBeats: number[];
}

export const DEFAULT_CLICK_PATTERN_CONFIG: ClickPatternConfig = {
  accentMode: 'first',
  beatsPerBar: 4,
  customAccentBeats: [0],
};

/**
 * `beatIndexInBar` is zero-indexed (0 = first beat of the bar). Returns which
 * sound that beat should play for the given pattern config.
 */
export function resolveClickSound(beatIndexInBar: number, config: Partial<ClickPatternConfig> = {}): ClickSound {
  const cfg = { ...DEFAULT_CLICK_PATTERN_CONFIG, ...config };

  switch (cfg.accentMode) {
    case 'all':
      return 'normal';

    case 'first':
      return beatIndexInBar === 0 ? 'accent' : 'normal';

    case 'backbeat': {
      // The classic drummer practice pattern: a clap on beats 2 and 4 (1-indexed),
      // nothing else. Generalizes to "every even-numbered beat" for other time
      // signatures, which is an approximation outside 4/4.
      const beatNumber = beatIndexInBar + 1;
      return beatNumber % 2 === 0 ? 'clap' : 'mute';
    }

    case 'custom':
      return cfg.customAccentBeats.includes(beatIndexInBar) ? 'accent' : 'normal';

    default:
      return 'normal';
  }
}

/** Zero-indexed beat position within its bar, for a given absolute click index. */
export function beatIndexInBar(clickIndex: number, beatsPerBar: number): number {
  if (beatsPerBar <= 0) return 0;
  return clickIndex % beatsPerBar;
}

/**
 * Which synthesized percussion voice the click track uses. All synthesized
 * in-browser (oscillators/filtered noise) -- no sample playback, so no
 * licensing concerns and no asset loading.
 */
export type SoundKit =
  | 'digital'
  | 'woodblock'
  | 'rimshot'
  | 'cowbell'
  | 'hihat'
  | 'clave'
  | 'kick'
  | 'snare'
  | 'shaker'
  | 'triangle';

export const SOUND_KITS: { label: string; value: SoundKit }[] = [
  { label: 'Digital', value: 'digital' },
  { label: 'Woodblock', value: 'woodblock' },
  { label: 'Rimshot', value: 'rimshot' },
  { label: 'Cowbell', value: 'cowbell' },
  { label: 'Hi-Hat', value: 'hihat' },
  { label: 'Clave', value: 'clave' },
  { label: 'Kick', value: 'kick' },
  { label: 'Snare', value: 'snare' },
  { label: 'Shaker', value: 'shaker' },
  { label: 'Triangle', value: 'triangle' },
];

/**
 * For a 'clap' hit (backbeat mode), the digital kit keeps its distinct airy
 * hand-clap sound; every other kit just plays its own accented voice on the
 * backbeat instead (a woodblock kit's backbeat is an accented woodblock
 * hit, not a generic clap sound layered on top of a different timbre).
 */
export function clapVoiceForKit(kit: SoundKit): 'digital-clap' | 'kit-accent' {
  return kit === 'digital' ? 'digital-clap' : 'kit-accent';
}

/**
 * Parse a user-facing, 1-indexed, comma-separated beat list (e.g. "1, 3")
 * into validated zero-indexed beat positions within `beatsPerBar`. Silently
 * drops anything out of range or non-numeric rather than throwing, since
 * this is meant to parse live text-field input.
 */
export function parseCustomAccentBeats(input: string, beatsPerBar: number): number[] {
  const seen = new Set<number>();
  for (const token of input.split(',')) {
    const n = Number(token.trim());
    if (Number.isInteger(n) && n >= 1 && n <= beatsPerBar) {
      seen.add(n - 1);
    }
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * Optional extra clicks evenly spaced between the main beat clicks -- a
 * quieter, plain tick layered under the accented beat pattern above.
 * Genuinely useful for practicing subdivided rhythms (linear fills, swung
 * eighths, triplet-based grooves) against a reference.
 */
export type Subdivision = 'none' | 'eighth' | 'triplet';

export const SUBDIVISION_OPTIONS: { label: string; value: Subdivision }[] = [
  { label: 'None', value: 'none' },
  { label: 'Eighths', value: 'eighth' },
  { label: 'Triplets', value: 'triplet' },
];

/** How many ticks make up one beat for a given subdivision setting (1 = just the beat itself). */
export function subdivisionTicksPerBeat(subdivision: Subdivision): number {
  switch (subdivision) {
    case 'eighth':
      return 2;
    case 'triplet':
      return 3;
    default:
      return 1;
  }
}

/**
 * A cold "2 & 4 clap" click can be disorienting to start on -- there's
 * nothing on the downbeat to feel the pulse against. This resolves which
 * accent mode a given bar should actually use: a straight, downbeat-
 * accented quarter-note count-in ('first') for the first `countInBars`
 * bars, then the real configured mode afterward -- like a drummer
 * counting "1-2-3-4" before dropping into the groove. A no-op (always
 * returns `configuredMode` unchanged) for any mode other than 'backbeat',
 * or when countInBars is 0, since this specific disorientation problem
 * only applies to a mode with silent downbeats.
 */
export function resolveEffectiveAccentMode(configuredMode: AccentMode, barIndex: number, countInBars: number): AccentMode {
  if (configuredMode !== 'backbeat' || countInBars <= 0) return configuredMode;
  return barIndex < countInBars ? 'first' : configuredMode;
}

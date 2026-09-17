/**
 * Color themes. Each `id` matches a `[data-theme="id"]` selector in
 * App.css that overrides the --accent/--secondary CSS variables; `swatch`
 * is only used to paint the picker buttons themselves (CSS vars reflect
 * whichever theme is currently active, so the swatches need their own
 * fixed hex values to show all options at once).
 */
export type ThemeId = 'amber' | 'cyan' | 'green' | 'coral' | 'violet';

export interface ThemeOption {
  id: ThemeId;
  label: string;
  swatch: string;
}

export const THEMES: ThemeOption[] = [
  { id: 'amber', label: 'Amber', swatch: '#ffb020' },
  { id: 'cyan', label: 'Cyan', swatch: '#4fd8e0' },
  { id: 'green', label: 'Green', swatch: '#6be37b' },
  { id: 'coral', label: 'Coral', swatch: '#ff7a5c' },
  { id: 'violet', label: 'Violet', swatch: '#b48cff' },
];

export const DEFAULT_THEME: ThemeId = 'amber';

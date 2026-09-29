import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Render the real App with the real hook, forcing only the one flag under test.
// (jsdom has no Web Audio, so a click can't genuinely be started here.)
let clickPlaying = false;
vi.mock('./hooks/useTempoDetector', async () => {
  const actual = await vi.importActual<typeof import('./hooks/useTempoDetector')>('./hooks/useTempoDetector');
  return {
    ...actual,
    useTempoDetector: () => {
      const real = actual.useTempoDetector();
      return { ...real, metronomeActive: clickPlaying };
    },
  };
});

import App from './App';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('App: Sync button visibility', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const syncButton = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Sync');

  it('shows a Sync button while the click is playing', async () => {
    clickPlaying = true;
    await act(async () => root.render(<App />));
    expect(syncButton()).toBeTruthy();
  });

  it('puts Sync in the same section as Stop Click, not down in the click settings', async () => {
    clickPlaying = true;
    await act(async () => root.render(<App />));
    const sync = syncButton()!;
    const stop = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Stop Click')!;
    expect(stop).toBeTruthy();
    expect(sync.closest('.main-section')).toBe(stop.closest('.main-section'));
  });

  it('hides Sync when no click is playing (there is nothing to sync)', async () => {
    clickPlaying = false;
    await act(async () => root.render(<App />));
    expect(syncButton()).toBeUndefined();
  });

  it('gives Sync an accessible name that contains its visible label', async () => {
    clickPlaying = true;
    await act(async () => root.render(<App />));
    expect(syncButton()!.getAttribute('aria-label')).toMatch(/^Sync/);
  });
});

# Tempo Lock

A mobile-first, in-browser live BPM detector for drummers and musicians.
Runs entirely on-device via the Web Audio API — nothing is recorded or
uploaded.

## Setup

```bash
npm install
npm run dev        # local dev server
npm run test       # vitest test suite
npm run typecheck  # tsc -b
npm run build      # production build (dist/)
```

## Architecture

The detector is split into a pure, fully unit-tested core and a thin
Web-Audio wiring layer:

- `src/lib/onsetDetection.ts` — energy envelope + adaptive-threshold onset
  (peak) picking. Pure functions over `Float32Array`s.
- `src/lib/tempoEstimator.ts` — turns onset times into a BPM estimate.
  Builds inter-onset intervals, votes candidate BPMs (with harmonics/
  sub-harmonics), and clusters votes by **millisecond** interval distance
  rather than percentage, which is what keeps fast tempos from being
  mis-clustered into their half-time neighbour. Exposes `estimateTempo()`.
- `src/lib/continuity.ts` — the tempo *transition* logic. A pure reducer
  (`updateContinuity(state, evidence, config)`) that smooths small drift,
  and requires three consecutive, mutually-agreeing estimates before
  accepting a large change (including half-time/double-time flips). Fully
  independent of audio and the DOM.
- `src/lib/tapTempo.ts` — manual Tap Tempo, using a trimmed median of
  recent tap intervals.
- `src/lib/clickPattern.ts` — which sound each beat in a bar should play,
  given an accent mode (all beats, accent-the-downbeat, "2 & 4 clap"
  backbeat, or a custom list of accented beats) and a time signature. Pure
  and signature-agnostic — `beatIndexInBar()` handles 3/4, 6/8, etc. Also
  defines the synthesized sound kits (Digital, Woodblock, Rimshot, Cowbell,
  Hi-Hat, Clave) and which voice a backbeat "clap" hit uses per kit.
- `src/lib/metronomeSchedule.ts` — click-track scheduling math: the
  "start after N bars of steady playing" countdown (phase-aligned to when
  the lock began, frozen at the tempo it locked at so drift during the
  countdown doesn't change the eventual click tempo, and reset if the lock
  breaks before it finishes), the click-time generator the audio engine
  schedules from, and bar/beat/remaining-bars position math for
  fixed-length sessions.
- `src/lib/layoutOrder.ts` — the pure array-reorder helper behind the
  Settings screen's drag-to-reorder section list.
- `src/lib/settingsStorage.ts` — pure parse/merge logic for restoring
  persisted settings, theme, and section order from `localStorage`, safe
  against missing or corrupted stored values.
- `src/lib/themes.ts` — the color theme definitions (id, label, swatch hex)
  shared between the theme picker and the `[data-theme]` CSS overrides in
  `App.css`.
- `src/audio/metronomeEngine.ts` — plays the actual click track, using a
  standard Web-Audio lookahead scheduler for tight timing. Supports the
  accent patterns and sound kits above, a configurable time signature, and
  either an open-ended session or a fixed bar count that auto-stops and
  reports its own bar/beat position for the UI to poll. All percussion
  voices are synthesized (oscillators + filtered noise) — no samples.
- `src/audio/silentAudio.ts` — generates a tiny silent WAV at runtime, used
  only to give Safari's AirPlay route picker a valid `<audio>` element to
  attach to.
- `src/audio/liveTempoEngine.ts` — the only file that touches
  `getUserMedia`/`AudioContext`. Pulls raw mic samples, runs them through
  the onset detector, periodically re-estimates tempo over a trailing
  8-second onset window, and feeds every estimate into the continuity
  tracker. Resets all state on start/stop.
- `src/hooks/useTempoDetector.ts` — React hook wrapping the live engine,
  tap tempo, the auto-start countdown, a manual metronome (arbitrary BPM,
  half/double buttons, play/stop), and settings/theme/section-order state
  (persisted to `localStorage`).
- `src/App.tsx` / `src/App.css` — the main performance screen (BPM readout,
  meters, Start/Stop, Tap Tempo, manual click controls) plus the color
  theme CSS variables.
- `src/Settings.tsx` — the settings overlay: Detector, Click Track, Sounds,
  and Appearance sections, each collapsible/reorderable by dragging its
  handle; the theme swatch picker; the sound kit selector; and the AirPlay
  button.

## Features

- Live BPM detection from mic input, with a locked/finding/low-confidence
  status and a smoothed, jump-resistant display.
- Tap Tempo, independent of the detector.
- A configurable click track: time signature (2/4–6/8), accent mode (all
  beats, accent-the-downbeat, "2 & 4 clap" backbeat, or custom beats), and
  a choice of synthesized percussion sounds.
- Two ways to start the click track: automatically after N bars of steady
  playing (phase-aligned to when the countdown began, tolerant of
  confidence noise), or manually at any BPM with half/double buttons and
  an optional fixed session length with a live bar/beat/remaining readout.
- Audible count-in: quiet clicks during the auto-start countdown bars, so
  the band hears it coming instead of a silent wait then a surprise click.
- Tempo ramp: a manually-started click track can step its BPM up (or
  down) by a fixed amount every N bars toward a target, then hold —
  classic speed-building practice.
- Setlist presets: save the current BPM/signature/click-mode/sound setup
  under a name, and tap it back in later instead of re-dialing every
  control between songs.
- Settings screen with drag-to-reorder sections, 5 color themes, and (on
  Safari/Apple devices) an in-app AirPlay device picker.
- Settings, theme, section order, and presets all persist across reloads
  via `localStorage`.
- Installable as a PWA.

## Testing

`src/lib/continuity.test.ts` and `src/lib/tempoEstimator.test.ts` cover the
scenarios called out in the spec: initial acquisition, small-drift
smoothing, isolated large jumps being rejected, acceptance after three
consistent estimates, half/double-time flips, the 5% agreement window,
low-confidence and insufficient-onset evidence, evidence returning to the
current tempo, missing estimates, out-of-range values, state reset, tempo
ranges (slow/medium/fast), fast tempos not collapsing to half-time,
tie-breaking, noisy/incomplete onsets, dropouts, drift, and abrupt changes.

Run `npm run test` for the full suite (130 tests as of this build).

## Known real-world limitations

This was tuned and tested against synthetic click trains and onset
patterns, **not** against real drum-kit recordings — actual accuracy on a
real kit has not been measured. In particular:

- **Phone placement and room acoustics matter a lot.** A phone lying flat
  near a kick pedal will see a very different signal than one clipped to a
  mic stand across the room; reflective rooms can smear onsets together.
- **Background noise** (talking, other instruments, PA bleed) can degrade
  onset detection quality, which is reported via the confidence/signal
  meters but can't be fully compensated for.
- **`ScriptProcessorNode`** is deprecated (though still broadly supported)
  and runs on the main thread; an `AudioWorklet`-based version would be
  more robust under load but needs a separate worklet module file, which
  was out of scope here.
- The onset detector is energy-based, tuned for percussive transients. It
  will be noticeably weaker on sustained, non-percussive material (e.g. a
  bowed string pad) than on drums.
- Extreme polyrhythms or tempo changes faster than the ~3-estimate
  consensus window (roughly half a second, given the 150ms analysis
  interval) will lag behind by design — that lag is what prevents the
  display from flickering on noise.
- **Click track auto-start**: keys off the displayed BPM value only, not
  the detector's confidence label — it deliberately keeps counting through
  brief confidence dips (band mix, room noise) since those don't mean the
  tempo reading itself is wrong. It only resets if the tempo reading is
  lost entirely or drifts by more than ~8% (a genuine tempo change).
  Once it's playing, it keeps going at a fixed tempo until you stop it,
  stop listening, or it reaches the end of a fixed-length session — it
  doesn't continue tracking your tempo after it kicks in. "2 & 4 clap"
  mode is tuned for 4/4 (even-numbered beats); in other signatures it's an
  approximation rather than a real backbeat pattern.
- **AirPlay**: the in-app device picker uses `webkitShowPlaybackTargetPicker`,
  a Safari/Apple-only browser API — it won't appear on Chrome, Firefox, or
  Android at all (feature-detected, so it just shows a note there instead).
  Picking a device there summons the *system* route picker; it doesn't pipe
  audio through a separate path, so it's a convenience button, not a
  requirement — routing to AirPlay/Bluetooth speakers via the device's own
  system audio controls works identically without it.
- **Sound kits**: all six (Digital, Woodblock, Rimshot, Cowbell, Hi-Hat,
  Clave) are synthesized from oscillators and filtered noise, not sampled
  recordings, so they're a reasonable approximation of the real instrument
  rather than a recording of one.
- **Count-in**: covers exactly the auto-start countdown's bars and stops
  itself right as the full-volume click track begins — both are computed
  from the same numbers, so they should hand off cleanly, but this hasn't
  been tested against a real, noisy room yet.
- **Tempo ramp**: only available on the manually-started click track, not
  the mic-triggered auto-start. The displayed BPM during a ramp comes from
  polling the engine's position every 100ms, so it can lag the actual
  audio by up to that long.
- **Presets**: capture BPM, signature, click mode/custom beats, sound kit,
  auto-start bars, and session length — not the detector settings
  (smoothing/sensitivity/range) or theme, since those are more "how I like
  the app to behave" than "how this song goes."
- **Settings persistence**: stored in `localStorage`, so it's per-browser,
  per-device — it won't sync between your phone and a laptop, and clearing
  site data resets it to defaults.

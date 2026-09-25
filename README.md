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
- **Live / Recording mode toggle**: Live analyzes the raw broadband
  signal (right for a stick/kit hit — a sharp transient across the whole
  spectrum). Recording low-passes the signal first to isolate the
  kick/bass pulse before analyzing, which is what lets a full song
  (vocals, guitar, synths all layered in the same mic pickup) come
  through as a countable pulse instead of a wash of onsets from every
  instrument firing at once. Only takes effect on the next Start
  Listening.
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

Run `npm run test` for the full suite (218 tests as of this build).

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
- **Subdivisions**: Settings → Sounds → Subdivision adds quiet, plain
  ticks evenly spaced between the main beat clicks (eighths = 1 extra
  tick per beat, triplets = 2). Genuinely useful for practicing subdivided
  rhythms against a reference. Applies to both the manual click track and
  the mic-triggered auto-start.
- **Live tempo tracking**: while a click track is playing and the mic is
  still listening, its tempo continuously nudges toward whatever's
  currently detected — a gentle blend (15% of the gap per tick), not a
  snap, so a band's natural tempo drift over a song gets tracked instead
  of the click running open-loop at whatever it locked at initially. This
  corrects the *speed* going forward; it doesn't retroactively fix
  accumulated *phase* error from before the correction started (a full
  phase-locked sync — always landing exactly on the beat — is a
  meaningfully bigger undertaking than this). No-ops during a ramp
  session, which has its own programmed schedule.
- **BPM readout precision**: both the live detected BPM and the running
  click track's tempo now display to 1 decimal place, since the
  underlying numbers are never actually whole — useful for judging how
  close (or not) the detector and the click currently are.
- **Visual beat pulse**: a small dot next to the BPM readout. Flashes in
  time with the actual click track when one is playing (driven by the
  same position polling as the Bar/Beat readout). When no click is
  playing but a tempo is locked from the mic, it pulses continuously at
  that tempo instead — this one is an approximate visual reference, not
  phase-locked to your actual hits, since there's no click audio to sync
  it to.
- **Landscape layout**: rotating the phone on its side automatically
  reflows the main screen into two columns instead of one tall vertical
  stack, via a CSS orientation media query — no JavaScript, no manual
  toggle, just reacts to the actual device rotation. Scoped to short
  viewports (`max-height: 500px`) so it only kicks in for phones, not
  landscape tablets/desktop which already have room to spare.
- **Live feel toggle**: while a click track is playing (auto-started or
  manual), ½× and 2× now toggle half-time/double-time feel in real time
  instead of only adjusting the pre-play dial — same underlying tempo and
  bar position, just fewer or more audible clicks, with no restart or
  phase jump. 2× inserts an extra evenly-spaced tick per beat; ½× mutes
  every other beat. Independent of the static Subdivision setting.
- **Live tempo tracking is now opt-in, off by default (this build)**: it
  was confirmed to cause exactly the failure it was trying to prevent —
  a click starting accurate and then drifting/going haywire after
  auto-start. The mechanism (continuously nudging the click's tempo
  toward whatever the mic detects) can't distinguish real external input
  from the click hearing its own audio if the device's speaker reaches
  its own mic, and that feedback compounds over time. Now off by default;
  Settings → Practice → "Live tempo tracking" to opt in if you're on
  headphones or an isolated mic setup where that risk doesn't apply.
- **Confidence calibration fix (this build)**: the tempo estimator's
  confidence used to be the winning candidate's *share* of vote weight
  across all harmonic candidates (fundamental, half-time, double-time,
  etc). That's miscalibrated for a very clean, consistent source — a
  steady stick tap populates its harmonic siblings just as cleanly as the
  real tempo, so the winner's share didn't reliably rise with more
  consistent evidence, and could sit below the acceptance threshold
  indefinitely even with obviously steady input (reported as "keeps
  looking for a tempo" despite consistent tapping). Confidence is now
  based on the winner's *absolute* vote count instead, which grows
  monotonically with real evidence regardless of how well-supported the
  octave siblings also are. Covered by new tests in
  `tempoEstimator.test.ts` asserting confidence rises with more onsets and
  doesn't spike from a bare-minimum onset count. This has only been
  verified against synthetic click trains, not a real kit — if it's still
  unreliable, the onset-count readout shown under the BPM display while
  status is "Finding tempo…" is there to help pin down whether onsets are
  even being detected at all versus a confidence/tuning issue.
- **Stop Click Track re-arm fix (this build)**: pressing "Stop Click
  Track" while still listening used to only stop the audio — the
  auto-start countdown would immediately begin counting again (the tempo
  was often still being detected), silently restarting the click a few
  seconds later and making the button look broken. An explicit stop now
  suppresses auto-start for the rest of that listening session; it
  re-arms on the next Start Listening or on changing the auto-start bars
  setting. This is hook-level orchestration (React state/refs across two
  audio engine instances), not pure logic, so it isn't covered by an
  automated test the way the modules above are — worth specifically
  re-confirming: stop the click, wait several seconds while still
  listening, and check it stays stopped.
- **Immediate/wrong-tempo auto-start fix (this build)**: two related
  issues could combine to make the click track fire almost immediately at
  an implausibly fast tempo. First, tapping on a hard, resonant surface
  (a table) can ring/bounce after the initial hit, and the onset detector's
  debounce window (100ms) was short enough that the bounce could register
  as a second, spurious onset — roughly doubling the apparent tempo from a
  single tap. The debounce is now 150ms (still comfortably permits a
  genuine 240 BPM tempo through). Second, once the auto-start countdown
  begins, its quiet count-in clicks play while the mic is still actively
  listening; if the device's speaker output reaches its own microphone,
  those clicks could be picked up as new "evidence," repeatedly resetting
  the countdown at a progressively faster, self-reinforcing tempo. The
  countdown's tempo reading is now frozen at whatever value started it for
  as long as the count-in is playing, closing that feedback path. Also
  raised the minimum onsets required before accepting any tempo reading at
  all (4 → 6), as a general hedge against a handful of incidental
  transients right as listening starts producing a confident-looking but
  wrong initial lock. The debounce fix has direct test coverage in the new
  `onsetDetection.test.ts`; the count-in feedback fix, like the one above,
  is hook-level wiring and isn't automated-tested.
- **Noise-floor calibration fix (this build)**: the onset detector's
  threshold was purely *relative* — is this frame louder than the recent
  local median? — with no absolute floor. That means steady ambient noise
  (room tone, mic self-noise, a fan) will always contain small bumps that
  look like "peaks" relative to their own immediate surroundings, and get
  misread as real hits, regardless of the sensitivity/smoothing sliders
  (neither of which set an absolute floor). This is the most likely
  explanation for the detector locking onto a fast, fluctuating tempo
  immediately on pressing Start Listening, with no real playing at all.
  Listening now spends its first ~0.6 seconds silently measuring the
  ambient noise floor before attempting any onset detection, and every
  onset candidate after that must clear that floor by a real margin (set
  by the sensitivity slider) to count at all. Covered by new tests in
  `onsetDetection.test.ts` (steady simulated room noise now produces zero
  onsets; a real hit well above the floor is still detected). If a
  Bluetooth headset's microphone is active as the input device, its much
  lower audio quality (most phones drop to an 8-16kHz voice-call profile
  when a Bluetooth mic is in use) could itself be a source of noisy,
  spurious onsets — worth confirming the input device is the phone/laptop's
  own mic, not a Bluetooth headset's, if this is still unreliable.
- **Subdivision moved to the main screen; diagnostics collapsed by
  default (this build)**: everything you'd realistically reach for
  mid-performance — turning the click on/off, adjusting tempo, nudging
  it, and now picking a subdivision — lives on the main screen, next to
  the click controls, not buried in Settings. The dense onset/confidence/
  candidate-list diagnostic text (genuinely useful for debugging, not
  something you need reaching over mid-song) is now tucked behind a small
  collapsed "Diagnostics" disclosure instead of always taking up space
  next to the controls that actually matter while playing. The
  Confidence/Signal meter bars themselves stay visible as before — those
  are a legitimate quick glance, just not the dense text underneath.
- **Tactile, hardware-inspired buttons (this build)**: inspired by a
  reference screenshot of a hardware-style performance app — every major
  button (Start/Stop Listening, Play/Stop Click, Tap Tempo, ½×/2×, the
  nudge buttons) is now bigger and reads as a raised, physical button
  rather than a flat rectangle: a layered shadow gives it a bevel edge
  and lift off the page, and pressing it now visibly pushes it in (an
  inset shadow, plus a real downward shift) instead of just a subtle
  scale-down. Purely visual — no functional changes.
- **Auto-start click: a clear on/off toggle (this build)**: previously,
  "just use the app for BPM detection" meant knowing to set "Auto-start
  after" to "Off" in a dropdown — not obvious. Split into a plain
  checkbox, "Auto-start click," with a one-line explanation of what each
  state means, plus the bar-count/"Once stable" detail dropdown appearing
  only when it's on. Toggling off and back on restores whatever detail
  was last chosen (remembered for the session) rather than resetting to
  a default. Live/Recording detection mode is unaffected either way —
  this only changes whether the *click* ever starts on its own.
- **Full visual redesign: "precision instrument" instead of vintage
  hardware (this build)**: a request for a genuinely different look — one
  that reads as professional and easy to use, not just refined —
  prompted a real design reconsideration, not another incremental pass.
  The prior direction (LCD screen panel, segmented LED meters, heavily
  embossed/beveled buttons, bordered cards around every section) was
  retro-hardware pastiche, and structurally it was the generic
  "boxes-with-borders-and-identical-shadows" pattern, not a considered
  choice. New direction: a serious stopwatch or tuner pedal, not a
  vintage synth — bold confident numerals, flat crisp surfaces, structure
  from generous spacing and type-weight rather than borders around
  everything. Concretely: a new ink-navy base palette (`--bg: #10121a`)
  instead of neutral near-black; the BPM readout dropped its screen-panel
  background and neon glow in favor of a bold 700-weight numeral doing
  the work on its own; the meters are clean flat bars again, not
  segmented LEDs; buttons lost their heavy embossed bevel shadows for a
  flat, confident press state; and the main-screen sections and Settings
  categories dropped their bordered-card treatment entirely — separation
  now comes from space (the hero's internal gap grew from 28px to 40px)
  and quiet, sentence-case labels, not boxes. All-caps section labels
  were also dropped throughout (a generic-template tell) in favor of
  plain sentence case.
- **LCD-panel BPM readout and LED-style meters (this build)**: pushing
  the hardware-device aesthetic further — the BPM number now sits in an
  actual recessed "screen" panel (a genuinely dark background, bordered,
  with an inset shadow simulating depth) instead of floating directly on
  the page background, the same way a real LCD display is set into a
  device's body. The Confidence/Signal meters switched from a smooth
  gradient fill to a segmented LED-bar look (small lit/unlit blocks),
  matching real VU-meter hardware instead of reading as a plain progress
  bar. Both work in light and dark mode — the screen panel stays
  genuinely dark either way, since that's how real hardware displays
  look regardless of the device body's color.
- **Same AudioContext suspension fix applied to the mic engine (this
  build)**: the click engine's fix from last build (explicit resume on
  creation, defensive recheck on every tick) applies equally well to the
  microphone's own AudioContext — it can suffer the same silent
  suspension (phone backgrounded, a call coming in), which would mean
  detection quietly stops working mid-session with no obvious error.
  Same fix, same reasoning, extended to cover detection as well as the
  click.
- **Auto-start plays one click then goes silent — fixed (this build)**: a
  report that manual Play Click worked fine but auto-start played exactly
  one click and then nothing pointed at something specific to *how* each
  one starts, not the trigger logic itself (which was traced through in
  full and is correctly guarded against re-firing). Manual Play Click is
  a direct button tap — a genuine user gesture, which browsers reliably
  let create and run an AudioContext. An auto-triggered click fires from
  inside a background analysis callback instead, with no direct gesture
  at that exact moment — and browsers, iOS Safari especially, can
  silently suspend a context created that way, sometimes after letting
  one already-scheduled sound through first. That matches the symptom
  exactly. Now explicitly resumes the context on creation, and
  defensively rechecks on every scheduling tick in case it gets
  suspended mid-session (phone backgrounded briefly, a call coming in,
  etc.) rather than silently staying mute for the rest of the session.
- **Phase nudge fixed and made noticeable (this build)**: a report that
  it "does not work or is not noticeable" was likely both — the
  mechanism itself was working (it takes effect within about a beat,
  since already-scheduled audio can't be retroactively moved), but 10ms
  per tap is genuinely hard to perceive, and there was no visible
  confirmation it had registered at all. Increased to 25ms per tap, and
  added a live "Timing: +25ms" readout next to the buttons so the nudge
  is visibly confirmed even before it's audible, plus a note that it
  takes about a beat to take effect, not instantly.
- **More visual separation (this build)**: inspired by the same hardware-
  app reference as the tactile buttons — more breathing room between the
  main-screen sections, more padding inside each one, and a new divider
  line within the Click Track section separating the mode-selection
  controls (Click mode, Subdivision, Count-in) from the performance
  controls below (tempo, feel, nudges, Play/Stop) — two genuinely
  different groups that were blurring together before.
- **Live phase nudge (this build)**: new "◂ Earlier" / "Later ▸" buttons,
  shown while a click is playing, for exactly "right tempo, just not
  quite landing on the beat" — shifts *when* the click plays by 10ms per
  tap without touching tempo at all (BPM nudging can't fix a phase
  offset, only a rate one). Also nudges the "Click timing" setting by the
  same amount, so the correction carries forward into the next
  auto-start too, not just the click that's currently running.
- **Subdivision volume (this build)**: Settings → Sounds → "Subdivision
  volume" — controls how loud the extra ticks (from the Subdivision
  setting, or a live ½×/2×/4×/8× feel) play relative to the main click,
  independent of the overall Click volume. Applies live.
- **Dark / Light mode (this build)**: Settings → Appearance now has a
  Dark/Light toggle above the color themes, fully independent of them —
  any accent color combines with either. Light mode uses a warm cream
  palette with proportionally softer shadows (the same shadow opacity
  that reads as depth on a dark background looks heavier on a light
  one).
- **"Once stable" adaptive auto-start (this build)**: a new option
  alongside (not replacing) the existing bar-count choices — instead of
  guessing 1 vs 2 vs 3 vs 4 bars up front, this triggers as soon as the
  detected tempo has genuinely settled, however long that takes. Reuses
  the same stability tracking already built for the "lock gets harder to
  dislodge over time" feature (`continuity.ts`'s `stableTicks` — updates
  since the displayed tempo last committed a real change), requiring
  roughly 2.25 seconds of continuous, uninterrupted stability before
  triggering. Deliberately does not also require a specific confidence
  label ('locked') on top of that, matching the existing bar-countdown's
  own established reasoning: confidence dips constantly in a real band
  mix even while the tempo reading itself holds steady, and requiring
  both would undermine that same noise tolerance. The resulting click
  still starts phase-aligned to the session's first-onset anchor, same
  as the bar-count modes. No count-in in this mode, since there's no
  fixed countdown length to count down through. 8 new tests in
  `metronomeSchedule.test.ts`.
- **Signal meter scaled per mode (this build)**: a screenshot showed a
  100% confidence, real onset count, and a sensible candidate list — but
  a 4% signal reading, from music playing through a stereo in Live mode.
  The meter's scale was tuned for a close stick/kit hit; music from a
  stereo across a room genuinely has a lower peak at the mic even when
  detection is working correctly, since onset detection itself uses a
  separate, adaptive threshold, not this fixed peak scale. Recording
  mode now gets its own, more sensitive scale, so a healthy signal in
  that mode doesn't read as alarmingly low for no real reason. Worth
  reiterating: Recording mode (not Live) is the one built for exactly
  this case — a full mix played through speakers.
- **Nudge fix + autocorrelation cross-validation (this build)**: found
  and fixed why −1/+1 "reset to the main tempo" instead of sticking — if
  live tempo tracking was enabled, it kept blending the running click's
  tempo back toward the detected value every ~150ms, undoing a manual
  nudge within about a second. A manual nudge now suppresses that
  background drift-correction for the rest of the click session, so it
  can no longer be silently overridden. Also did real research into how
  established tools (Essentia, librosa, the academic MIR literature --
  Scheirer 1998, Ellis & Pikrakis 2006, Percival & Tzanetakis 2014) do
  tempo detection: the dominant approach is autocorrelation of a
  continuous onset-strength signal, not clustering discrete onset
  intervals (this app's original approach). Added autocorrelation as a
  genuinely independent second signal (`autocorrelation.ts`, including
  parabolic peak interpolation for sub-sample accuracy), cross-checked
  against the existing estimator specifically for octave (half/double-
  time) resolution — agreement between two structurally different
  algorithms is real evidence, not just a second guess from the same
  method. 18 new tests across `autocorrelation.test.ts` and
  `tempoEstimator.test.ts`. This is a genuine architectural upgrade
  grounded in the actual literature, not another ad-hoc heuristic — but
  like everything else here, it needs real-world testing to confirm it
  measurably helps.
- **Audio output latency compensation + manual timing offset (this
  build)**: a report of the click being "displaced ever so slightly" —
  correct tempo, just not landing exactly on the beat — pointed at
  something genuinely different from everything fixed so far: the delay
  between Web Audio scheduling a sound and it actually reaching the
  speaker, which was never accounted for. The click now auto-compensates
  using the browser's own `outputLatency`/`baseLatency` reporting where
  available, scheduling every click that much earlier so it's audible
  closer to the intended instant rather than technically-on-time-
  internally-but-audibly-late. This can only correct what the browser
  can actually measure, though — Bluetooth speakers and headphones
  commonly add real delay (often 100ms+) that's completely invisible to
  any web API, no way around that. For whatever that leaves, Settings →
  Sounds → "Click timing" is a manual ±100ms slider to fine-tune by ear
  for your specific hardware.
- **Bigger nudge buttons (this build)**: −1/+1 now span the full width of
  the manual-metronome block, side by side, with much larger touch
  targets and text — meant to be hittable mid-performance without
  looking closely.
- **3-bar auto-start option (this build)**: "Auto-start after" now offers
  1/2/3/4 bars, not just 1/2/4 — a genuine gap in the previous range.
- **Mic permission requested on app open (this build)**: the browser's
  permission prompt genuinely cannot be skipped or pre-authorized — no
  page can bypass that, it's a hard security boundary, not a technical
  limitation of this app. What's achievable: the app now requests (and
  immediately releases) mic access as soon as it opens, rather than
  waiting for Start Listening. That one-time browser prompt now happens
  up front; since the resulting permission grant is normally remembered
  per-origin, Start Listening itself typically won't prompt or wait on
  anything by the time you actually need it.
- **Main screen reorderable, real-screenshot fixes (this build)**: from a
  screenshot of the app in actual use — the four main-screen blocks
  below the BPM readout (Detection Mode, Listen, Tap Tempo, Click Track)
  are now drag-to-reorder, same pattern as Settings sections, with the
  handle and Move Up/Down buttons at the top of each block as requested.
  The BPM readout itself stays fixed at the top, anchoring the page.
  Also fixed a real bug visible in that screenshot: the BPM number
  ("107.5") was clipping off the left edge of the screen — the font
  sizing (30vw) was tuned before decimal display was added and could
  overflow for anything wider than a 3-digit whole number. Resized with
  a `clamp()` that reliably fits a full "199.9"-length reading. Also
  added a bit more top clearance in the header, since iOS draws its own
  transient "microphone active" overlay over page content while
  listening — a best-effort mitigation, not a guaranteed fix, since that
  overlay is outside what page CSS can fully control.
- **Auto-start bar count moved to the main screen (this build)**: same
  treatment as Click mode — "Auto-start after" (Off/1/2/4 bars) is now
  next to the mode toggle on the main screen, not buried in Settings.
- **2 & 4 clap count-in moved to the main screen (this build)**: the
  "Count-in before the clap starts" option now appears directly under
  Click mode on the main screen when 2 & 4 Clap is selected, instead of
  in Settings.
- **Subdivision/feel ticks use the actual kit sound (this build)**: extra
  ticks — from the static Subdivision setting or from the live 2×/4×/8×
  feel toggle — now play the selected sound kit's own normal voice
  (Kick, Snare, whichever is chosen) instead of a fixed generic tone, so
  they sound consistent with the main click rather than an unrelated
  beep.
- **Live BPM display + tempo nudge (this build)**: the BPM number between
  ½× and 2× now shows the click's actual live tempo while it's playing
  (read-only; becomes the editable dial again once stopped). New −1/+1
  buttons below it nudge the tempo by exactly 1 BPM — live, with no
  restart, while a click is running, or just the pre-play dial when it
  isn't.
- **First-click catch-up (this build)**: the phase-alignment fix above
  computes an *exact* bar-boundary instant for the click to start on, but
  the code deciding when to trigger it reacts on a ~150ms polling
  interval, not instantly — so by the time it actually calls start(),
  that exact instant can already be a little in the past. The engine was
  treating that like any other late click (silently dropped, waiting for
  the next beat), which meant occasionally skipping straight to beat 2 —
  audible as a brief pause before the click "caught on." Now, only for
  the very first click of a session, if it's already passed by the time
  it's scheduled, it plays right away instead of waiting a full beat. The
  bar/beat grid itself is unaffected — only that one click's audible
  timing gets nudged if needed; everything after stays on the original,
  correctly-aligned schedule.
- **Bar countdown phase-aligned to the actual first hit (this build)**: a
  request to make sure the click starts exactly at the start of the bar
  after the N-bar count-in (bar 2 for a 1-bar count, bar 3 for 2 bars)
  surfaced a real gap: the countdown was starting from whenever the
  detector first produced a tempo reading, not from when the player
  actually started playing. Detection needs several onsets (currently 6)
  to accumulate before it can estimate a tempo at all, so that first
  reading can already be a beat or more into the bar the player started
  on — meaning the N-bar count wasn't counting from true bar 1. The
  countdown now anchors to the time of the very first onset detected
  this session (assumed to be the downbeat) instead, so the click lands
  exactly N bars after the actual first hit. Covered by 5 new tests in
  `metronomeSchedule.test.ts`; a genuine mid-song tempo change still
  resets the countdown using the current time as before, since there's
  no reliable "first onset of the new tempo" to anchor to there.
- **Hard lock after auto-start (this build)**: for real gig use — count
  in, play the confirming bars, the app locks the tempo, and it should
  never move again until you stop it — detection now fully stops
  re-evaluating the moment the auto-start countdown completes and the
  click begins. Not just the click's own tempo (which already stayed
  fixed by default); the BPM readout, confidence, and diagnostics all
  freeze at their exact values from that moment and stay there for the
  rest of the session, regardless of what the mic picks up afterward.
  A "🔒 Locked for this session" notice confirms it visually. Only Stop
  Listening (a fresh start) clears it. Scoped to the auto-start path
  specifically, since that's the described workflow; a manually-started
  click while the mic happens to also be listening is unaffected.
- **Sample-accurate onset timing (this build)**: a report of the BPM
  jumping between values with no clean relationship to each other (90 →
  288 → 212, not clean 2x/3x octave multiples) pointed away from the
  tempo-estimation logic — which has been the focus of several previous
  fixes — and toward something more basic: how onset times get their
  timestamp in the first place. Each analysis tick was reconstructing
  "when did this audio happen" via a fresh `performance.now()` read and
  subtracting a sample-count-based delay — but that tick runs on its own
  timer, independent of when the audio was actually captured, so JS
  scheduling jitter (event-loop delays, GC pauses, mobile throttling)
  could put onsets from different ticks on subtly inconsistent time
  axes, corrupting the interval math between them in a way that looks
  like noise rather than a clean octave error. Onset timestamps are now
  anchored to the audio hardware's own sample-accurate clock (each audio
  chunk's `playbackTime`, captured once per session as a fixed reference
  point) instead of being reconstructed from wall-clock time on every
  tick — the same pattern already used successfully in the click
  engine's own scheduling. This is a genuine, previously-unexamined
  candidate for the root cause of the erratic-reading reports across
  several sessions; needs real-world confirmation.
- **BPM + click controls anchor at least half the page (this build)**: the
  BPM readout and the manual click controls are now wrapped together in a
  `min-height: 55vh` hero section, since detecting and clicking a tempo is
  the app's whole point — everything else (setlist, secondary notices)
  lives below it. Reset to `auto` height in the landscape layout (where
  vertical space is already tight) via `display: contents`, so the two-
  column reflow still works correctly there instead of forcing one giant
  unbroken block into a single column.
- **Visual refresh (this build)**: softer, more consistent corner
  rounding across buttons/panels/inputs via shared `--radius-*` tokens;
  layered shadows for depth on buttons, cards, and the settings panel;
  a frosted backdrop blur behind the Settings overlay; smoother
  transitions on presses and state changes; a stronger, more atmospheric
  glow on the BPM readout plus a very subtle radial gradient behind it;
  and an explicit `:focus-visible` ring in the accent color on every
  interactive element, for keyboard/switch-control navigation. Contrast
  ratios and touch target sizes are unchanged — this is a depth/polish
  pass, not a redesign.
- **Candidate-list diagnostics (this build)**: despite several
  reasonable, targeted fixes across sessions (debounce, noise floor,
  re-analysis overlap, confidence calibration, lock stability), a report
  of jumping between 80 → 210 → 240 → 90 while clicking a stick at a
  steady 80 BPM suggests the raw tempo estimator itself is, for
  stretches of several seconds at a time, genuinely computing a wrong
  answer with enough apparent support to survive the stability
  safeguards — not just an occasional noisy estimate slipping through.
  That points upstream of continuity, into onset detection or the
  estimator's candidate scoring, which none of the fixes so far have
  been able to directly observe. The diagnostic line (visible under the
  meters whenever listening, not just while status is "Finding tempo…")
  now shows the estimator's actual top 3 candidates with their score and
  support count, e.g. "candidates: 240 (52%, n=9), 80 (31%, n=6), 60
  (12%, n=3)" — real visibility into what the estimator is choosing
  between, rather than just the final smoothed number. This doesn't fix
  the bug; it's meant to make the next report diagnosable instead of
  another guess.
- **Lock stability grows over time (this build)**: previously, an
  established tempo lock was exactly as easy to dislodge with 3
  consecutive agreeing estimates whether it had been locked for half a
  second or thirty seconds — described as "the app is listening too
  intently" and "it should be consistent after 2-4 bars," which was
  exactly right. A lock now gets progressively more resistant to a major
  change the longer it holds (one extra required consecutive estimate
  per ~8 stable updates, capped at +3), so a few seconds of noise-driven
  agreement can't knock out an already-solid reading the way it could
  before — while a genuine, sustained tempo change can still eventually
  get through. A freshly-acquired lock is unaffected (still just 3, same
  as before). Covered by 6 new tests in `continuity.test.ts`.
- **Play/Stop merged into one button (this build)**: instead of a
  separate "Stop Click Track" button appearing elsewhere on screen, the
  same button now toggles — "Play Click" when nothing's playing, "Stop
  Click" once it is, regardless of whether the click was started manually
  or auto-triggered by the mic.
- **Click mode moved to the main screen (this build)**: switching between
  All Beats / Accent 1 / 2 & 4 Clap / Custom no longer requires opening
  Settings — it's right above the manual click controls. The mode-specific
  sub-options (the count-in-bars choice for 2 & 4 Clap, the custom beat
  list for Custom mode) stay in Settings, since those are secondary
  configuration for whichever mode is picked, not the mode choice itself.
- **4 new sound kits + maximum gain (this build)**: added Kick (low
  pitch-swept thump), Snare (noise crack + body tone), Shaker (soft,
  sustained noise, gentler than the hi-hat), and Triangle (two detuned
  high sines for a real shimmering ring, longer decay than the other
  ticks) — 10 kits total now. Every voice's gain was pushed to the
  actual safe ceiling: single-source sounds (Digital, Woodblock, Hi-Hat,
  Clave, Kick, Shaker) sit right at the edge of clipping (~0.9-0.95 peak).
  Sounds that layer multiple simultaneous sources — Rimshot and Snare
  (noise + tone), Cowbell and Triangle (two oscillators) — are capped
  lower on purpose: those layers sum together at the final output, and
  Web Audio hard-clips (distorts) past ±1.0 rather than normalizing, so
  pushing them to the same literal ceiling as a single-source sound would
  make them louder *and* distorted, not just louder. That's a genuine
  technical ceiling, not an arbitrary conservative choice.
- **2 & 4 clap count-in (this build)**: a cold backbeat-only click has
  nothing on the downbeat to feel the pulse against, which can be
  disorienting to start on. Settings → Click Track → "Count-in before
  the clap starts" (only shown when Click mode is "2 & 4 clap") adds 1
  or 2 bars of a straight, downbeat-accented quarter-note count-in —
  like counting off "1-2-3-4" — before the real backbeat pattern kicks
  in. Applies to both the mic-triggered auto-start and a manually-started
  click. Covered by 5 new tests in `clickPattern.test.ts`.
- **Stacking feel toggle (this build)**: ½× and 2× now stack instead of
  being a fixed 3-state toggle — each press of 2× doubles the click rate
  again (1× → 2× → 4× → 8×), each press of ½× halves it again
  (1× → ½× → ¼× → ⅛×), clamped at those endpoints since further is no
  longer musically meaningful. Still live, still no restart or phase
  jump. Faster-than-1× keeps inserting extra evenly-spaced ticks (2× = 2
  ticks/beat, 4× = 4, 8× = 8); slower-than-1× mutes all but one beat out
  of every N-beat cycle (½× = every other beat, ¼× = one in four, ⅛× = one
  in eight). Covered by 17 tests in `feel.test.ts`.
- **Click volume**: Settings → Sounds → Click volume, applies live even
  while a click is already playing (no restart). Also raised the base
  gain of every synthesized sound (roughly 1.4-1.8x, cowbell less to
  manage its two-oscillator headroom) — the previous levels were tuned
  conservatively to avoid clipping and turned out too quiet in practice.
- **Tap-tempo-seeded octave resolution (this build)**: when the tempo
  estimator has to resolve an ambiguous reading (is this a 120 BPM
  quarter-note pulse or its 240 BPM double-time?), it can now use the
  current Tap Tempo value as a reference — tap in the quarter note
  before pressing Start Listening, and the very first mic-based read
  uses that to break the tie, instead of guessing blind. Only overrides
  a genuine octave relationship (half/double/third) with a
  reasonably-supported candidate near the tapped value; it won't force
  an unrelated or barely-present reading. This is a meaningful step, not
  a full solve — octave ambiguity is a known-hard problem in tempo
  detection, and once the detector locks onto its own reading, the tap
  reference stops being consulted (the existing ½×/2× live toggle
  remains the tool for correcting a wrong guess after the fact). Covered
  by new tests in `tempoEstimator.test.ts`.
- **Settings explanations (this build)**: Smoothing and Sensitivity now
  have plain-language descriptions of which direction to move them and
  why (ghost notes/grace notes vs. a solid, consistent pulse).
- **Sliding-window re-analysis fix (this build)**: with "Auto-start after"
  set to Off, the BPM readout itself was still showing a stable, fast
  (~200 BPM) tempo with no real input — ruling out both the noise-floor
  fix above and the auto-start/count-in logic entirely, and pointing
  squarely at the onset detector. The engine re-scanned its *entire*
  rolling ~1.5s audio buffer from scratch every 150ms tick, relying only
  on a small (0.05s) de-duplication window to avoid double-counting.
  Re-scanning the same overlapping audio repeatedly can detect the exact
  same physical blip again near a shifted buffer boundary — since the
  adaptive threshold's context window starts at a different point each
  tick — fabricating a steady, spurious "onset" roughly every analysis
  tick, independent of anything real. That produces exactly a stable
  (not fluctuating), fast, input-independent BPM. The engine now tracks
  how much audio it has already analyzed and only re-examines genuinely
  new audio each tick (plus a small trailing overlap purely for the
  adaptive threshold's context, with onsets found inside that overlap
  explicitly discarded as already-considered). This is the audio-pipeline
  wiring itself, so — like the fixes above — it isn't unit-tested the
  pure-module way; it needs a real microphone to actually confirm.
- **Recording mode**: a first pass at full-mix tempo detection — a single
  150Hz low-pass filter to isolate the kick/bass pulse, with all the same
  frame/hop/debounce timing as Live mode. Real beat-tracking tools go
  further (dedicated kick/snare separation, tempo-specific tuning per
  genre); this is a reasonable starting point, not a guarantee it'll
  nail every song's tempo, especially bass-light genres or masters where
  the kick isn't prominent. Untested against a real recording so far.
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
- **VoiceOver / screen-reader support**: the BPM number no longer sits in
  a continuously-announcing live region (it changes many times a second,
  which would be overwhelming) — it's now readable on demand as a single
  summary ("Current tempo: 128.4 beats per minute"). A separate, quieter
  live region announces meaningful state changes instead: status
  transitions (Locked, Finding tempo…) and the click track starting or
  stopping. Every control that lacked an accessible name now has one
  (manual BPM input/slider, preset name field, mode/theme toggles now
  also expose their selected state via `aria-pressed`). The Settings
  drag-to-reorder list — which native HTML drag-and-drop doesn't support
  with VoiceOver at all — now has Move Up/Move Down buttons on every
  section as a first-class alternative, not a hidden fallback. The
  Settings panel is now a proper dialog (announced as one, closes on
  Escape). This is UI/markup work with no pure-logic surface, so — like
  the audio-pipeline fixes above — it isn't unit-tested; it was built
  from a careful audit but hasn't been run through an actual screen
  reader yet, so real testing with VoiceOver would be the next step to
  confirm it holds up in practice.
  auto-start bars, and session length — not the detector settings
  (smoothing/sensitivity/range) or theme, since those are more "how I like
  the app to behave" than "how this song goes."
- **Settings persistence**: stored in `localStorage`, so it's per-browser,
  per-device — it won't sync between your phone and a laptop, and clearing
  site data resets it to defaults.

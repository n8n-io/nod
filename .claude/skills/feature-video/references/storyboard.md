# Storyboard, brand and components

## Contents

1. Timing grid
2. Video skeleton
3. Copy rules
4. Brand tokens
5. `feature-linux` components
6. Music config

## 1. Timing grid

- **Tempo:** 120 BPM: a beat is 0.5 s and a bar is 2 s. Put scene cuts, impacts and big entrances on beats.
- **Drop:** the drop is at 4.0 s, after a 2 s build (snare roll from 2.0 s, riser from about 2.55 s, a silent gap at 3.75–4.0 s).
- **Length:** 20–30 s total; 27.5 s fits a feature video with a 1.5 s music tail.
- **Stage:** the page is a 540×540 CSS stage at device scale 2, so it renders at 1080×1080. Body text 13–16 px reads on a phone; headlines are 44–58 px.

## 2. Video skeleton

`templates/release.html` builds the timeline from `RELEASE`:

- **Hook (0–4 s):** the poster is the version wordmark, or `hook.title` (two lines, `<pink>` allowed) for a single feature, plus one chip per feature. The chips fly into the glyph, a caption appears, and the camera zooms through the ring.
- **One beat per feature:** 4 s by default, 6 s for `app`; set `len` on a feature to override, in whole bars (2 s). Each has an eyebrow `0N · label`, a 2-line headline (`<pink>…</pink>` marks the accent word), and a collage photo frame with a UI panel. The panel kinds are:
  - `app`: captures from `scripts/capture.mjs` in `shots/`. `states` (`shot`, `at`; later states crossfade in, `chime: true` marks a finished result), `pan` (camera keys: `top`, or `shot` + `rect` with `pad` or `align: 'center'`), `cursor` (keys with `shot`, `rect`, optional `click`, `fx`/`fy`, `dx`/`dy`) and `marks` (a pink highlight over a `rect` at `at`). Times are seconds within the beat; the visible window is 456×290 px, shown 1:1 from a 456 px wide capture;
  - `chat`: `you`, `live`, `reply`, `rows`;
  - `terminal`: `lines`; a line starting with `$ ` is typed, and `<ok>…</ok>` turns green;
  - `list`: `rows` with check marks;
  - `prompts`: `rows` as user bubbles.
- **End card (3.5 s).**
- **Limits:** 20–30 s in total: five 4 s beats, or two 6 s and two 4 s beats, make 27.5 s. Keep each feature's headline to about 3 words per line and each row under about 48 characters.
- **Music:** `window.SOUND` already carries the cues (whoosh per transition, pops per row, chime per reply, typing ticks for terminal lines).

## 3. Copy rules

- Headlines are a claim or a pain in the viewer's words, not feature names. Keep them to 2 lines of about 3 words, with one pink accent word that carries the point.
- Prompts read like real messages the owner would send. Where possible, reuse the release highlights' or the docs' prompt wording.
- Nod's replies are short and specific (counts, names, dates). Live-line steps describe real actions ("Reading 6 invoices", "Listing Documents/Vault").
- Eyebrows and pills use the mono font in uppercase and stay short.
- Use dates around today's date and fictional companies.
- When a limit matters (preview, requirements, manual updates, "only in work you start"), say it plainly in a trust or needs scene.

## 4. Brand tokens

- **Colours:**
  - ink `#191919`, ink-2 `#464646`, muted `#676767`, border `#e0e0e0`, background `#fafafa`;
  - pink `#ff91ac`, pink-10 `#ffe8ec`, pink-20 `#ffd0d9` (the user's bubble), pink-70 `#87003c` (icon ink, switch on);
  - panel `#f1f1f1` with a debossed inset shadow.
- **Fonts:**
  - n8n Baumer Uniwidth for headlines and in-video text, and Baumer Mono for eyebrows and pills (landing page style);
  - Geist and Geist Mono inside app windows and terminals (the app's real fonts);
  - the system font for macOS dialogs, notifications and Finder.
- **Glyph:** a ring plus a pink dot (`viewBox 0 0 21 21`, circle at 9,12 with r 7.375 and stroke 3.25, dot at 17,4 with r 3.45). The "nod" motion rotates the dot 46° around (9,12) and back over about 0.6–0.95 s.
- **Backgrounds:** the dot-grid frame behind headlines (`assets/dot-grid.svg` at 10 px), and the square paper collage (`assets/collage.png`) behind app scenes with a 0.2 black shade, Ken Burns from 1.02× to 1.10×.
- **Reuse:** before inventing a component, check the app's own CSS (`src/web/**/*.css`) and the landing page (`docs/src/styles/nod.css`). Use neutral cards with a 1 px border, round-ended pills and status pills, and avoid coloured left borders.

## 5. `feature-linux` components

Element IDs are given so you can find a component quickly in the template.

- `.hookterm`: the big typed command in the hook.
- `.topbar`: a GNOME-like panel, with no logos.
- `.term`: a terminal with a `lines` array (`at`, `prompt`, `type`, `html`), a progress `.bar` and auto-scroll.
- `.nodwin`: the app window. It plays the captures `welcome-top` and `welcome-bottom` (a scroll to **Get started**, then the click, measured from the capture's `start` rect), then `chat-working` and `chat-done`.
- `.srow`: requirement rows.

## 6. Music config (`music.mjs`)

Any `.mjs` (default export) or `.json` file:

```js
export default {
  duration: 27.5,
  chords: { F: { notes: [53, 57, 60, 64], bass: 41 }, Am: { notes: [55, 57, 60, 64], bass: 45 } },
  progression: ['F', 'Am', 'Dm', 'Bb'],
  dropAt: 4,
  overrides: { 22: 'Dm', 24: 'Bb' },
  kicks: [
    [0, 3, 0.85],
    [4, 21.5],
    [24, 26],
  ],
  groove: [
    [4, 21.5],
    [24, 26],
  ],
  introHats: [[0, 3]],
  softHats: [[21.5, 23]],
  breakdown: [[22, 24]],
  silence: [[3.75, 4]],
  rolls: [
    [2, 3.75],
    [23, 23.9, 0.4],
  ],
  fills: [14.5],
  risers: [[2.55, 1.45, 0.34]],
  impacts: [
    [0, 0.35],
    [4, 0.75],
    [24, 0.75],
  ],
  final: { time: 26, chord: [53, 57, 60, 64, 67, 72], bass: 41 },
  mix: { kick: 0.78, bass: 0.28, sub: 0.45, impactSub: 0.55, lowcut: 48 },
  sfx: [
    { type: 'pop', t: 2.9, freq: 520, len: 0.3, gain: 0.3, verb: 0.15 },
    {
      type: 'pops',
      times: [18.85, 19.35],
      freqs: [698.5, 784],
      gain: 0.22,
      pan: 0.2,
      alternate: true,
    },
    { type: 'type', text: 'the prompt being typed', from: 6.45, to: 8.25 },
    { type: 'click', t: 8.42 },
    { type: 'enter', t: 1.95 },
    { type: 'tick', t: 12.9, freq: 2400 },
    { type: 'ticks', times: [], freqs: [] },
    { type: 'whoosh', t: 5.72, dur: 0.45 },
    { type: 'chime', t: 12.62, notes: [880, 1046.5, 1396.9] },
  ],
};
```

What each field does:

- **`progression`:** one chord per bar. `progression[0]` lands on the drop bar, and the bars before it continue the cycle backwards (so `F, Am, Dm, Bb` gives the intro Dm, Bb).
- **`overrides`:** pins the chord for the bar that starts at the given second.
- **`kicks` and `groove`:** `kicks` places one kick per beat in each range. `groove` adds the full kit and bass.
- **`final`:** a big chord plus a hit; the music fades out over the last 0.6 s.

---
name: feature-video
description: Make a short square video of a Nod feature or release with real frontend captures, made-up data, and synthesized music. Use for a requested feature demo or when preparing a desktop release, including one that contains only fixes. Try for every release, but continue with text notes if the video fails quality checks or cannot be made. Skip individual fix, refactor, and docs PRs.
---

# Feature video

Produces a 1080×1080, 60 fps, 20–30 s MP4 (H.264 High + AAC, −14 LUFS). Each video is an HTML page whose `render(t)` draws any moment deterministically. Headless Chrome captures every frame, a Node synth writes the music, and ffmpeg muxes them. The app scenes are captures of the real Nod frontend running on made-up data. The cursor, camera and cuts are composed over them, so every frame is exact and repeatable.

Make one for a requested user-facing feature. Try to make one for each desktop release, including one that contains only fixes: show how those fixes improve Nod. An individual fix PR needs no video. A video failure must not block a release.

Paths below are relative to this skill's directory (`<skill>`). Work in a temporary folder outside the repository, and never commit captures, pages or videos.

You need Node 22 or later, ffmpeg, Chrome or Chromium (set `CHROME` to its binary if it isn't found), zsh, and the repository's dependencies installed. Rendering loads the n8n brand fonts from `n8n.io`, so it needs a network connection.

## 1. Get the facts right first

The video may be shared in public, so every claim must be true of the code it shows.

- **Behaviour and limits:** read the feature's docs page in `docs/src/content/docs/` and the code for exact UI strings.
- **Release content:** during release preparation, use `version`, `source`, and `highlights` from `desktop/release.json`. The release need not exist yet. For a published release, use `gh release view nod-vX.Y.Z`. Keep the highlights' wording and check every claim against that source.
- **Jobs:** show a job finishing only when you have seen Nod finish it, or the docs show it. Otherwise show it as a prompt the viewer could type.
- **Names and data:** only made-up companies and people (Brightline Studio, Sara Kim, Fernway Hosting, Northwind Office, Metro Taxi). No real accounts, keys, emails or private content.
- **Logos:** no third-party logos. Product names in text are fine.
- **Limits:** if a limit matters to the viewer (preview status, requirements, manual updates), put it in the video.

## 2. Capture the shipped UI

A viewer should see the feature the way they will meet it in Nod. So the app scenes are screenshots of the real frontend, never a rebuilt look-alike. `scripts/capture.mjs` runs the frontend of a Nod checkout with Vite, answers every `/api` request from a fixtures file, drives headless Chrome through a plan, and saves 2× screenshots plus the positions of the controls you name. It starts no server, database or container, and reads no real account.

1. **Pick the checkout.** For a pull request, use the branch you are on. During release preparation, add a detached worktree at `desktop/release.json.source` outside the repository. For a published release, use its tag. Install that checkout's dependencies with `pnpm install --frozen-lockfile --ignore-scripts`.
2. **Write fixtures:** one JSON object keyed by request (`"/api/trust"`, `"POST /api/schedules/s1/run"`; a key without a query matches any query). Start from `references/example-capture/release/fixtures.json`, which boots the app shell (`linux/` has the welcome screen and a chat). Take the response shapes from `src/shared/contracts.ts` and the other files in `src/shared`. Requests with no fixture are listed at the end of a run; add the ones the screen needs. A response can also change later responses: `{ "$respond": …, "$then": { other fixtures } }` answers with `$respond` and then puts the `$then` fixtures in place, so a click that starts a run is followed by the running state.
3. **Write a plan** (`references/example-capture/release/plan.json`): a viewport, a fixed `time`, and steps: `goto`, `click` and `hover` (by `selector` or visible `text`), `fixtures` (swap responses mid-flow, such as before a click that starts a run), `eval`, `wait`, and `shot`. A shot takes named `rects` for every control the cursor, camera or highlight will use, and an optional `clip` (crop to an element, or from it down with `toBottom`). The fixtures file is never changed; swaps last only for that run.
4. **Run it:** `node <skill>/scripts/capture.mjs <checkout> fixtures.json plan.json <workdir>/shots`. Read every screenshot before you use it.

Rules:

- **Fit the frame, at 1:1.** Set the viewport to the width of the frame the capture sits in (456 px for an `app` panel, 448 px for the Linux app window), so the UI is shown at its real size and never scaled. Crop to the part that matters, not the whole page with its top bar. Trim the fixture data until the state fits the frame without a camera move. One short pan is fine when a state grows, such as a log opening. A tour around the page is not.
- **One interaction per feature:** the action that explains it (open a row, select **Run now**). Capture the state before, the state after, and any state in between that the app really shows.
- **Trim the data, not the UI.** If something doesn't fit, shorten the fixture text or drop a row. Never hide, restyle or redraw a control.
- **Real states only.** Every state must come from the app reacting to the plan's steps, or to fixtures a real server could return.
- **Fallback.** Use `list` rows for an "Also in this release" beat or a change with no screen. A feature video has at most one `list` beat. A release that contains only fixes can use the text summary below. The `chat` kind is a recreated chat; prefer a captured one, as `linux/` shows.

## 3. Pick a template

| Template        | Use for                                                      | What it has                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release`       | one feature told in 2–4 beats, or a release (3–5 highlights) | Data-driven: edit one `RELEASE` object. The hook shows the version, or `hook.title` for a single feature. Feature kinds: `app` (captures with cursor clicks, pans and highlights), `chat`, `terminal`, `list`, `prompts`. Timeline and music cues are computed from it. |
| `feature-linux` | platform, install or setup news                              | A typed terminal install, a desktop top bar, and an app window that plays captures (`welcome-top`, `welcome-bottom`, `chat-working`, `chat-done` from `references/example-capture/linux`) with a **Get started** click, then requirement rows.                          |

Read `references/storyboard.md` before you change structure. It has the timing grid, copy rules, brand tokens and the fields of each panel kind.

### Releases that contain only fixes

Keep the same visual quality, motion, music, and 20–30 second length. Make the first frame say that this version improves Nod. Use the version in `hook.eyebrow` and a large `hook.title`, such as “A little polish.” / “A better Nod.” Pick copy that fits the actual fixes.

Show two or three specific improvements from the highlights. Use real captures when the corrected behavior is visible. For fixes without a useful screen, use one `list` beat per improvement. Three beats with `len: 6` last 25.5 seconds with the hook and end card. Two beats with `len: 8` last 23.5 seconds. Give each beat its own large benefit headline and short rows that say what now works. Do not invent a screen, a feature, a completed job, or a before-and-after demonstration. Do not claim faster, safer, or more reliable behavior without evidence. The end card should invite the viewer to update for those fixes.

## 4. Build

```sh
<skill>/scripts/init.sh <workdir> <template> <name>
cd <workdir>
node <skill>/scripts/capture.mjs <checkout> fixtures.json plan.json shots
node <skill>/scripts/render.mjs stills <name>.html 0,2.6,5,8,10.4,13,16,19.5,23,26 stills
ffmpeg -y -loglevel error -pattern_type glob -i 'stills/t*.png' -vf "scale=400:400,tile=4x3:padding=6:color=white" -frames:v 1 sheet.png
```

Read `sheet.png`, and single stills at full size where detail matters, after every round of edits. Check that:

- frame 0 is a finished poster;
- every scene reads at phone size;
- transitions carry content, with no empty frames;
- cursors land on the control they click;
- no text clips or overlaps.

## 5. Music

- **`release`:** run `node <skill>/scripts/render.mjs sound <name>.html <name>.music.json`. The page computes its own cues.
- **`feature-linux`:** edit `<name>.music.mjs`. Move each `sfx` time to match the events you changed on the page.
- **Synthesize:** `node <skill>/scripts/music.mjs <config> <name>.wav`.

The engine is a 120 BPM track (kick, clap, hats, sidechained pads, pluck arp, risers, impacts) plus UI sounds. Give each video its own `progression` so a series doesn't sound identical.

## 6. Render and finish

```sh
node <skill>/scripts/render.mjs video <name>.html silent.mp4
<skill>/scripts/finish.sh silent.mp4 <name>.wav <name>.mp4
```

`finish.sh` muxes, sets −14 LUFS, prints the specs and writes `<name>-poster.png` and `<name>-sheet.png`. Read both from the finished file before you report.

## 7. Report

- Give the full path and a short scene-by-scene summary with timestamps.
- For an ordinary feature PR, tell the author to drag the MP4 into its **Summary**. Leave that upload to the author.
- For an authorized release PR, follow [Make the release video](../../../docs/src/content/docs/contribute/desktop-releases.mdx#make-the-release-video). Attach the MP4 only if it meets this skill's quality standard. Record its URL with `node .github/scripts/prepare-desktop-release.mjs --video URL` and commit the manifest. Check that the public video loads and matches the notes. Regenerate after changes to the version, source, or highlights. If the video fails quality checks, creation, validation, or upload, leave `video: null` and report the specific reason in the PR without secrets or private content. Remove any rejected video from the PR description. Continue with text notes. Do not lower the quality standard or block the release for a video. Do not merge or publish without authorization.
- State the caveats: the music is synthesized and you have not listened to it; `app` scenes are the real frontend with made-up data and composed motion; any other app scene is a recreation; which jobs are shown finishing and why.

## Gotchas

- **Fonts load lazily.** Every template preloads its families in `window.ready`; do the same for any font you add.
- **Hidden scenes measure as 0 px.** Call `render(t)` for a time when the element is visible before measuring it.
- **The first frame is the thumbnail.** Start fully composed and animate from there.
- **Keep content visible during transitions.** In a push transition, start the incoming scene's content as it slides in.
- **Cut on the 0.5 s grid.** Scene cuts, impacts and drops sit on beats (bars every 2 s, drop at 4.0 s).
- **Fixtures decide the screen.** If the app shows onboarding, an error or an empty page, a response is missing or has the wrong shape. Read the capture's list of requests without a fixture.

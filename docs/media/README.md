# Docs media

The Trust and Vault tour and six screenshots use the current app components with synthetic API data: four of Usage, one of Vault and one of a private form. The capture has no backend, model connection or connected account. Fields for private values stay empty. The tour states that the model check can make mistakes.

From the repository root, with dependencies installed:

```sh
pnpm run build
node docs/media/capture.mjs
node docs/media/compose.mjs
```

Capture needs Google Chrome. Set `NOD_MEDIA_CHROME` if its path differs from the macOS default. The command writes temporary files to `.local/nod-media`. It refuses a page error, an unknown API request or an old product name.

Composition needs macOS `say` with the Daniel voice, plus `ffmpeg`. It records each sentence with one voice, adds matching captions, and joins complete scenes with a short fade. It does not paint labels over an earlier video.

To select another output folder, pass it as the first argument to both commands. The second argument to `compose.mjs` selects the video asset folder. After visual review, copy the six PNG files from the output `screens` folder to `docs/src/assets/screens`.

The other screenshots and banners retain their original synthetic content. Their text edits use the app font and move the following text to keep normal word spacing.

Verify the result with OCR, then review each screenshot, every video scene, each transition, captions and browser playback. Run `pnpm --dir docs build` to check the site and its links. Fixture checks do not prove live sign-in or payment completion.

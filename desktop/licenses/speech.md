# Local speech components

The standalone phoneme processor uses Spellophone 0.2.1 and eSpeak NG 1.52.0, licensed under GPL-3.0-or-later. It accepts text and a language and returns a JSON phoneme string on standard output. Input is one JSON object on standard input, with `text` and `voice` (`en-us`, `en-gb`, `es`, `fr-fr`, `hi`, or `it`). The processor's source is included at `../../src/providers/local-speech/phonemizer-worker.ts`. This processor is distributed under GPL-3.0-or-later; the application's root Apache-2.0 license does not replace the licenses of its third-party components.

Spellophone is copyright 2026 Spelling Creator. eSpeak NG is copyright its contributors, including Jonathan Duddington and Reece H. Dunn; individual files in its source retain their copyright and license notices. These components are provided without warranty. You may copy, modify, and redistribute them under the included `GPL-3.0.txt` terms.

The complete corresponding source is included beside this notice:

- `spellophone-source.tar.gz`: Spellophone source, C glue, build scripts, dependency lockfile, and build instructions at commit `6d51a872d54a773e4969d7130fdaed665b2d6d18`.
- `espeak-ng-source.tar.gz`: eSpeak NG 1.52.0 source at commit `4870adfa25b1a32b4361592f1be8a40337c58d6c`.
- `sources.json`: pinned source URLs, sizes, and SHA-256 hashes verified during packaging.

To rebuild Spellophone, extract its archive, place the extracted eSpeak NG source at `vendor/espeak-ng`, apply the included deterministic dictionary patch with `patch -d vendor/espeak-ng -p1 < vendor/patches/0001-deterministic-dictionary-compile.patch`, install the toolchain declared in `mise.toml`, run `pnpm install --frozen-lockfile`, then run `pnpm --filter @spelling-creator/spellophone build`. The upstream release uses Emscripten 6.0.12 and Node.js 24. The bundled processor can be modified as ordinary TypeScript and started with Node.js and the bundled `tsx` loader. No code-signing key is needed to run a modified processor outside the signed app.

The npm provenance record for Spellophone 0.2.1 binds its published archive to the source commit above: https://registry.npmjs.org/-/npm/v1/attestations/@spelling-creator%2fspellophone@0.2.1. Upstream build documentation: https://github.com/Spelling-Creator/spellophone/tree/6d51a872d54a773e4969d7130fdaed665b2d6d18.

The local inference runtime separately uses Transformers.js and ONNX Runtime (Apache-2.0 and MIT), the Kokoro model and voices (Apache-2.0), Whisper model weights (MIT), and vozz Portuguese phonemization (Apache-2.0). Their package licenses remain alongside `engine/node_modules`; model revisions and checksums are declared in `src/providers/local-speech/models.ts`. The models are downloaded only when local speech is enabled. This notice is limited to the local speech feature and is not a complete inventory of the application.

The French `ff_siwis` voice is identified by the Kokoro voice card as derived from the SIWIS French Speech Synthesis Database, 2016. Attribution: Junichi Yamagishi, Pierre-Edouard Honnet, Philip Garner, and Alexandros Lazaridis (2017), University of Edinburgh, Centre for Speech Technology Research, https://doi.org/10.7488/ds/1705. The dataset is licensed under Creative Commons Attribution 4.0 International: https://creativecommons.org/licenses/by/4.0/. It is provided without warranties. The voice is a derived model representation; nod downloads the upstream voice weights unchanged and does not distribute the original recordings. Upstream voice card: https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md.

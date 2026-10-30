import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { cardPage, type Card } from './chart.ts';

const run = promisify(execFile);

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((path): path is string => Boolean(path) && existsSync(path!));
}

export async function renderImages(cards: Card[], directory: string) {
  const chrome = findChrome();
  if (!chrome) throw new Error('No Chrome or Chromium found. Set CHROME_PATH to render images.');
  await mkdir(directory, { recursive: true });
  const files: string[] = [];
  const base = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--virtual-time-budget=3000',
  ];
  for (const card of cards) {
    const page = join(directory, `${card.id}.html`);
    const image = join(directory, `${card.id}.png`);
    await writeFile(page, cardPage(card));
    const url = pathToFileURL(page).href;
    const dom = await run(chrome, [...base, '--window-size=1600,900', '--dump-dom', url], {
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const height = Math.max(900, Number(/<title>(\d+)<\/title>/.exec(dom.stdout)?.[1]) || 900);
    await run(
      chrome,
      [
        ...base,
        '--force-device-scale-factor=2',
        `--window-size=1600,${height}`,
        `--screenshot=${image}`,
        url,
      ],
      { timeout: 60_000 },
    );
    files.push(image);
  }
  return files;
}

import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import type { Activity } from '../../shared/contracts';

const quietMinutes = (since: string) => Math.floor((Date.now() - Date.parse(since)) / 60_000);

const idleWords = [
  'Nodding along…',
  'Nodding thoughtfully…',
  'Connecting the nodes…',
  'Wiring it up…',
  'Untangling the wires…',
  'Plugging in…',
  'Workflowing…',
  'Tracing the flow…',
  'Following the thread…',
  'Joining the dots…',
  'Lining up the dominoes…',
  'Lining things up…',
  'Sketching a plan…',
  'Doodling on a napkin…',
  'Mapping it out…',
  'Picking a path…',
  'Rummaging…',
  'Sorting the pile…',
  'Shuffling the deck…',
  'Squinting at the details…',
  'Reading between the lines…',
  'Turning it over…',
  'Weighing it up…',
  'Chasing a hunch…',
  'Putting two and two together…',
  'Counting on fingers…',
  'Rolling up sleeves…',
  'Looking under the hood…',
  'Dusting off the toolbox…',
  'Warming up the gears…',
  'Oiling the cogs…',
  'Flipping switches…',
  'Tuning in…',
  'Humming quietly…',
  'Untying knots…',
  'Nudging the pieces…',
  'Polishing the plan…',
  'Gathering threads…',
  'Finding the right drawer…',
  'Fitting the puzzle together…',
];

function useQuietMinutes(since: string, enabled: boolean) {
  const [minutes, setMinutes] = useState(() => quietMinutes(since));
  useEffect(() => {
    setMinutes(quietMinutes(since));
    if (!enabled) return;
    const timer = setInterval(() => setMinutes(quietMinutes(since)), 15_000);
    return () => clearInterval(timer);
  }, [since, enabled]);
  return enabled && minutes > 0 ? minutes : 0;
}

function useIdleWord(enabled: boolean) {
  const [order] = useState(() => {
    const words = [...idleWords];
    for (let index = words.length - 1; index > 0; index--) {
      const pick = Math.floor(Math.random() * (index + 1));
      [words[index], words[pick]] = [words[pick]!, words[index]!];
    }
    return words;
  });
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setIndex((current) => (current + 1) % order.length), 2500);
    return () => clearInterval(timer);
  }, [enabled, order]);
  return order[index]!;
}

export function LiveLine({ item, quiet = true }: { item?: Activity; quiet?: boolean }) {
  const step = item?.step?.trim();
  const site = item?.doing === 'tool' ? item.site : null;
  const described = step || site;
  const queued = item?.doing === 'queued';
  const word = useIdleWord(!described && !queued);
  const minutes = useQuietMinutes(item?.quietSince ?? '', quiet && Boolean(item));
  const meta = [step ? site : null, minutes ? `${minutes} min` : null].filter(Boolean).join(' · ');
  return (
    <span>
      {described ? (
        <Markdown allowedElements={[]} unwrapDisallowed>
          {described}
        </Markdown>
      ) : queued ? (
        'Working…'
      ) : (
        <>
          <span className="sr-only">Working…</span>
          <span aria-hidden="true">{word}</span>
        </>
      )}
      {meta && ` · ${meta}`}
    </span>
  );
}

import base from './sales-pdf-report.ts';
import type { Session } from '../session.ts';
import type { World } from '../scenario.ts';

export default {
  ...base,
  id: 'sales-pdf-report-tsv',
  title: 'Deliver the sales PDF from a tab-separated export in reverse month order',
  world(clock: { now(): number }) {
    const world = base.world(clock) as World & { csv: string };
    const [header, ...rows] = world.csv.split('\n');
    world.csv = [header, ...rows.reverse()].join('\n').replaceAll(',', '\t');
    return world;
  },
  async play(session: Session, world: World) {
    await base.play(
      {
        ...session,
        upload: (_name, bytes) => session.upload('sales.tsv', bytes, 'text/tab-separated-values'),
      },
      world,
    );
  },
};

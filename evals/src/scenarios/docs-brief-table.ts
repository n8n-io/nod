import base from './docs-brief-summary.ts';

export default {
  ...base,
  id: 'docs-brief-table',
  title: 'Read the current project brief from a table beside a newer superseded file',
  world(clock: { now(): number }) {
    const world = base.world(clock);
    const current = world.apps!.drive!.files.find(
      (file) => file.name === 'Meridian project brief',
    )!;
    current.text = current
      .text!.split('\n')
      .filter(Boolean)
      .reverse()
      .map((line, index) => `${index + 1}\t${line}`)
      .join('\n');
    return world;
  },
};

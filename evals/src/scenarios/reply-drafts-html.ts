import base from './reply-drafts.ts';
import { escapeHtml } from '../world/sites.ts';

export default {
  ...base,
  id: 'reply-drafts-html',
  title: 'Draft replies from HTML email with the same thread and calendar constraints',
  tier: 'release' as const,
  calibration: 'pending' as const,
  world(clock: { now(): number }) {
    const world = base.world(clock);
    for (const mail of world.apps!.gmail!.mails)
      mail.body = mail.body
        .split('\n\n')
        .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`)
        .join('');
    return world;
  },
};

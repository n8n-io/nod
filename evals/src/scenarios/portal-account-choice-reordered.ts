import base from './portal-account-choice.ts';

export default {
  ...base,
  id: 'portal-account-choice-reordered',
  title: 'Choose the correct saved tax account when the other account is listed first',
  tier: 'release' as const,
  calibration: 'pending' as const,
  world(clock: { now(): number }) {
    const world = base.world(clock);
    world.logins!.reverse();
    return world;
  },
};

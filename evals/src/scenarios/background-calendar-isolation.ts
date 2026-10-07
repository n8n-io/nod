import { backgroundCalendar } from '../world/background-calendar.ts';

export default backgroundCalendar({
  id: 'background-calendar-isolation',
  title: 'An incoming event does not repeat a pending calendar request',
  summary: 'Workshop planning',
  hour: 8,
  minute: 0,
  gate: 'read',
});

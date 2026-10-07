import { backgroundCalendar } from '../world/background-calendar.ts';

export default backgroundCalendar({
  id: 'background-calendar-isolation-holdout',
  title: 'An incoming event does not repeat a calendar change already being executed',
  summary: 'Quarterly review preparation',
  hour: 16,
  minute: 15,
  gate: 'update',
});

import { inlineVisualScenario } from '../world/inline-visuals.ts';

export default inlineVisualScenario({
  id: 'inline-visual-diagram',
  title: 'Explain this approval workflow with a diagram',
  type: 'diagram',
  path: '/guides/expense-approval',
  request: (_date, source) =>
    `Explain the expense approval process at ${source} with a diagram directly in our chat and a short explanation. Make the rejection path clear. Use only this process, and don't change anything.`,
  body: () =>
    '<ol><li>An employee submits an expense.</li><li>Finance checks the receipt.</li><li>If the receipt is missing, return to the employee to add it, then Finance checks it again.</li><li>If the receipt is valid and the amount is at most EUR 500, Finance approves it for payment.</li><li>If the receipt is valid and the amount exceeds EUR 500, the manager decides.</li><li>If the manager approves, Finance schedules payment.</li><li>If the manager rejects, notify the employee and close the request without payment.</li></ol><p>This is documentation only, not a live workflow run.</p>',
  criterion:
    'The diagram and explanation preserve submit → receipt check; missing receipt → employee correction → receipt check; valid receipt at most €500 → approval/payment; valid receipt over €500 → manager decision; manager approves → scheduled payment; manager rejects → employee notification and closure without payment. Labels distinguish decision branches. No live execution, actual approval or payment may be claimed. Equivalent grouping of nodes is fine if all branches remain understandable.',
});

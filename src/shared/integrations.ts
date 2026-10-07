export const integrationServiceIds = [
  'gmail',
  'googlecalendar',
  'googledrive',
  'googlesheets',
  'googledocs',
  'slack',
  'notion',
  'linear',
] as const;

export type IntegrationService = (typeof integrationServiceIds)[number];

export const integrationServices: Record<
  IntegrationService,
  { name: string; description: string }
> = {
  gmail: { name: 'Gmail', description: 'Find email and stay on top of replies.' },
  googlecalendar: {
    name: 'Google Calendar',
    description: 'Plan your time and follow meeting changes.',
  },
  googledrive: {
    name: 'Google Drive',
    description: 'Find files and keep documents within reach.',
  },
  googlesheets: { name: 'Google Sheets', description: 'Read and update your spreadsheets.' },
  googledocs: { name: 'Google Docs', description: 'Work with your notes and documents.' },
  slack: { name: 'Slack', description: 'Find conversations and keep up with your team.' },
  notion: { name: 'Notion', description: 'Find and work with your pages and databases.' },
  linear: { name: 'Linear', description: 'Find projects and issues in your workspace.' },
};

export type IntegrationService = string;

export interface IntegrationServiceInfo {
  slug: string;
  name: string;
  description: string;
  logoUrl?: string;
  categories?: string[];
}

export type IntegrationKeyStatus = { managed: boolean; saved: boolean; suffix: string | null };

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

export const integrationServiceIds = Object.keys(integrationServices);

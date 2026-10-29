export const senderApps: Record<
  string,
  { name: string; domains?: string[]; senders?: string[]; locals?: string[] }
> = {
  slack: { name: 'Slack', domains: ['slack.com'] },
  notion: { name: 'Notion', domains: ['notion.so', 'notion.com', 'makenotion.com'] },
  linear: { name: 'Linear', domains: ['linear.app'] },
  n8n: { name: 'n8n', domains: ['n8n.io', 'n8n.cloud'] },
  github: { name: 'GitHub', domains: ['github.com'] },
  gitlab: { name: 'GitLab', domains: ['gitlab.com'] },
  jira: { name: 'Jira', domains: ['atlassian.net'], locals: ['jira'] },
  confluence: { name: 'Confluence', domains: ['atlassian.net'], locals: ['confluence'] },
  asana: { name: 'Asana', domains: ['asana.com'] },
  trello: { name: 'Trello', domains: ['trello.com'] },
  clickup: { name: 'ClickUp', domains: ['clickup.com'] },
  monday: { name: 'monday.com', domains: ['monday.com'] },
  todoist: { name: 'Todoist', domains: ['todoist.com'] },
  figma: { name: 'Figma', domains: ['figma.com'] },
  miro: { name: 'Miro', domains: ['miro.com'] },
  airtable: { name: 'Airtable', domains: ['airtable.com'] },
  hubspot: { name: 'HubSpot', domains: ['hubspot.com'] },
  salesforce: { name: 'Salesforce', domains: ['salesforce.com'] },
  zendesk: { name: 'Zendesk', domains: ['zendesk.com'] },
  intercom: { name: 'Intercom', domains: ['intercom.io', 'intercom-mail.com'] },
  calendly: { name: 'Calendly', domains: ['calendly.com'] },
  zoom: { name: 'Zoom', domains: ['zoom.us'] },
  dropbox: { name: 'Dropbox', domains: ['dropbox.com', 'dropboxmail.com'] },
  stripe: { name: 'Stripe', domains: ['stripe.com'] },
  shopify: { name: 'Shopify', domains: ['shopify.com'] },
  discord: { name: 'Discord', domains: ['discord.com'] },
  googlecalendar: { name: 'Google Calendar', senders: ['calendar-notification@google.com'] },
  googledrive: {
    name: 'Google Drive',
    senders: ['drive-shares-dm-noreply@google.com', 'drive-shares-noreply@google.com'],
  },
  googledocs: { name: 'Google Docs', senders: ['comments-noreply@docs.google.com'] },
};

export function moreIdeasLine(slugs: string[]) {
  const apps = slugs
    .filter((slug) => Object.hasOwn(senderApps, slug))
    .slice(0, 3)
    .map((slug) => senderApps[slug].name);
  if (!apps.length) return 'If you want more ideas, just ask me.';
  const names =
    apps.length === 1 ? apps[0] : `${apps.slice(0, -1).join(', ')} and ${apps[apps.length - 1]}`;
  return `If you want more ideas, just ask me. You also get email from ${names}, so connecting ${apps.length === 1 ? 'it' : 'them'} would help me find more.`;
}

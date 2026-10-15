const apps: Record<string, string> = {
  GMAIL: 'Gmail',
  GOOGLECALENDAR: 'Google Calendar',
  GOOGLESHEETS: 'Google Sheets',
  GOOGLEDOCS: 'Google Docs',
  GOOGLEDRIVE: 'Google Drive',
  SLACK: 'Slack',
  NOTION: 'Notion',
  LINEAR: 'Linear',
};

export function actionTitle(action: string) {
  if (action === 'CONNECTED_HTTP') return { app: '', label: 'Call a connected API' };
  if (action === 'CONNECTED_MCP_CALL') return { app: '', label: 'Run a tool on a connected app' };
  if (action === 'CONNECTED_CLI') return { app: '', label: 'Run a connected command line tool' };
  const [app, ...words] = action.split('_');
  return {
    app: apps[app!] ?? `${app![0]}${app!.slice(1).toLowerCase()}`,
    label: words.join(' ').toLowerCase(),
  };
}

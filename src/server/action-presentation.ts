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

const tools: Record<string, string> = {
  bash: 'Ran a command',
  read: 'Read a file',
  write: 'Wrote a file',
  edit: 'Edited a file',
  find: 'Looked for files',
  ls: 'Listed files',
  'web search': 'Searched the web',
  'fetch content': 'Read a web page',
  'get search content': 'Read search results',
  'source check': 'Checked a source',
  browser: 'Used the browser',
  'sign in': 'Signed in',
  pay: 'Entered a card',
  'browser session': 'Opened a saved session',
  apps: 'Used a connected app',
  'manage apps': 'Checked connected apps',
  'manage personal context': 'Checked schedules or memory',
  skills: 'Used a skill',
  'send message': 'Sent you a message',
  'follow up': 'Queued a follow-up',
  delegate: 'Started a helper',
  'ask user': 'Asked you',
  'react to message': 'Reacted to a message',
  task: 'Updated the task',
  'share file': 'Shared a file',
  'create audio': 'Made audio',
};

export function toolTitle(summary: string) {
  const server = /^mcp {2}(.+?) {2}.+$/.exec(summary)?.[1];
  return server ? `Used ${server}` : (tools[summary] ?? summary);
}

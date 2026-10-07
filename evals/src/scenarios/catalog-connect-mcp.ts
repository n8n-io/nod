import { catalogConnection } from '../world/app-catalog.ts';

export default catalogConnection({
  id: 'catalog-connect-mcp',
  slug: 'clickup_mcp',
  name: 'ClickUp MCP',
  prompt: 'Can you connect my ClickUp account?',
});

import { catalogConnection } from '../world/app-catalog.ts';

export default catalogConnection({
  id: 'catalog-connect',
  slug: 'airtable',
  name: 'Airtable',
  prompt: 'Connect my Airtable account.',
});

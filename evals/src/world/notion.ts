import { randomUUID } from 'node:crypto';
import { iso, list, num, obj, str, words, type Args, type Tool } from './app-kit.ts';

type Value = string | number | boolean | string[] | null;
type Kind =
  | 'title'
  | 'rich_text'
  | 'number'
  | 'select'
  | 'status'
  | 'multi_select'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'people';

export interface NotionPage {
  id?: string;
  title: string;
  parent?: string;
  markdown?: string;
  properties?: Record<string, Value>;
  archived?: boolean;
  edited?: number;
}

export interface NotionDatabase {
  id?: string;
  title: string;
  parent?: string;
  schema: Record<string, { type: Kind; options?: string[] }>;
  rows: Array<Omit<NotionPage, 'parent' | 'title'> & { properties: Record<string, Value> }>;
}

export type StoredPage = Required<Omit<NotionPage, 'properties'>> & {
  properties?: Record<string, Value>;
  database?: string;
};

export function notion(
  owner: { name: string; email: string },
  seed: { pages?: NotionPage[]; databases?: NotionDatabase[] },
  now: () => number,
) {
  const databases = (seed.databases ?? []).map((database) => ({
    ...database,
    id: database.id ?? randomUUID(),
    parent: database.parent ?? 'workspace',
    schema: structuredClone(database.schema),
  }));
  const titleOf = (database: (typeof databases)[number]) =>
    Object.entries(database.schema).find(([, item]) => item.type === 'title')?.[0] ?? 'Name';
  const pages: StoredPage[] = [
    ...(seed.pages ?? []).map((page) => ({
      id: page.id ?? randomUUID(),
      parent: page.parent ?? 'workspace',
      markdown: page.markdown ?? '',
      archived: page.archived ?? false,
      edited: page.edited ?? now() - 86_400_000,
      title: page.title,
    })),
    ...databases.flatMap((database) =>
      database.rows.map((row) => ({
        id: row.id ?? randomUUID(),
        parent: database.id,
        database: database.id,
        title: String(row.properties[titleOf(database)] ?? ''),
        markdown: row.markdown ?? '',
        archived: row.archived ?? false,
        edited: row.edited ?? now() - 86_400_000,
        properties: { ...row.properties },
      })),
    ),
  ];
  const comments: Array<{ id: string; page: string; text: string; at: number }> = [];
  const url = (pageId: string) => `https://www.notion.so/${pageId.replaceAll('-', '')}`;
  const bare = (value: unknown) =>
    String(value ?? '')
      .replace(/-/g, '')
      .toLowerCase();
  const findPage = (pageId: unknown) => {
    const key = bare(pageId);
    const page = pages.find((item) => bare(item.id) === key || key.endsWith(bare(item.id)));
    if (!page) throw new Error(`Could not find page with ID: ${pageId}.`);
    return page;
  };
  const findDatabase = (databaseId: unknown) => {
    const key = bare(databaseId);
    const database = databases.find((item) => bare(item.id) === key || key.endsWith(bare(item.id)));
    if (!database) throw new Error(`Could not find database with ID: ${databaseId}.`);
    return database;
  };
  const parentView = (parent: string) =>
    parent === 'workspace'
      ? { type: 'workspace', workspace: true }
      : databases.some((item) => item.id === parent)
        ? { type: 'database_id', database_id: parent }
        : { type: 'page_id', page_id: parent };
  const rich = (text: string) => [{ type: 'text', text: { content: text }, plain_text: text }];
  const propertyView = (type: Kind, value: Value) => {
    switch (type) {
      case 'title':
      case 'rich_text':
        return { type, [type]: rich(String(value ?? '')) };
      case 'number':
        return { type, number: value === null || value === '' ? null : Number(value) };
      case 'select':
      case 'status':
        return { type, [type]: value ? { name: String(value) } : null };
      case 'multi_select':
        return { type, multi_select: [value ?? []].flat().map((name) => ({ name: String(name) })) };
      case 'date':
        return { type, date: value ? { start: String(value) } : null };
      case 'checkbox':
        return { type, checkbox: Boolean(value) };
      case 'people':
        return { type, people: [value ?? []].flat().map((name) => ({ name: String(name) })) };
      default:
        return { type, [type]: value ?? null };
    }
  };
  const pageView = (page: StoredPage) => {
    const database = page.database
      ? databases.find((item) => item.id === page.database)
      : undefined;
    return {
      object: 'page',
      id: page.id,
      url: url(page.id),
      parent: parentView(page.parent),
      archived: page.archived,
      last_edited_time: iso(page.edited),
      properties: database
        ? Object.fromEntries(
            Object.entries(database.schema).map(([name, item]) => [
              name,
              propertyView(item.type, page.properties?.[name] ?? null),
            ]),
          )
        : { title: { type: 'title', title: rich(page.title) } },
    };
  };
  const databaseView = (database: (typeof databases)[number]) => ({
    object: 'database',
    id: database.id,
    url: url(database.id),
    title: rich(database.title),
    parent: parentView(database.parent),
    properties: Object.fromEntries(
      Object.entries(database.schema).map(([name, item]) => [
        name,
        {
          name,
          type: item.type,
          ...(item.options
            ? { [item.type]: { options: item.options.map((option) => ({ name: option })) } }
            : {}),
        },
      ]),
    ),
  });
  const blockLine = (block: Args): string => {
    const kind = String(block.type ?? block.block_property ?? Object.keys(block)[0] ?? '');
    const text = words(block.content ?? block[kind] ?? block);
    if (/^heading_1/.test(kind)) return `# ${text}`;
    if (/^heading_2/.test(kind)) return `## ${text}`;
    if (/^heading_3/.test(kind)) return `### ${text}`;
    if (kind === 'to_do') return `- [${block.to_do?.checked || block.checked ? 'x' : ' '}] ${text}`;
    if (kind === 'bulleted_list_item') return `- ${text}`;
    if (kind === 'numbered_list_item') return `1. ${text}`;
    if (kind === 'quote') return `> ${text}`;
    return text;
  };
  const append = (pageId: unknown, blocks: unknown) => {
    const page = findPage(pageId);
    const lines = [blocks ?? []]
      .flat()
      .map((item) => (item && typeof item === 'object' ? (item as Args) : { paragraph: item }))
      .map((item) => blockLine(item.content_block ?? item))
      .filter((line) => line.trim());
    if (!lines.length) throw new Error('No content to append.');
    page.markdown = [page.markdown, ...lines].filter(Boolean).join('\n');
    page.edited = now();
    return page;
  };
  const blocks = (page: StoredPage) => [
    ...page.markdown
      .split('\n')
      .filter((line) => line.trim())
      .map((line, index) => {
        const todo = /^- \[( |x)\] (.*)$/.exec(line);
        const heading = /^(#{1,3}) (.*)$/.exec(line);
        const bullet = /^- (.*)$/.exec(line);
        const [type, text, extra] = todo
          ? ['to_do', todo[2], { checked: todo[1] === 'x' }]
          : heading
            ? [`heading_${heading[1].length}`, heading[2], {}]
            : bullet
              ? ['bulleted_list_item', bullet[1], {}]
              : ['paragraph', line, {}];
        return {
          object: 'block',
          id: `${page.id}-b${index}`,
          type,
          [type]: { rich_text: rich(text), ...extra },
          has_children: false,
        };
      }),
    ...pages
      .filter((item) => item.parent === page.id && !item.archived && !item.database)
      .map((item) => ({
        object: 'block',
        id: item.id,
        type: 'child_page',
        child_page: { title: item.title },
        has_children: true,
      })),
    ...databases
      .filter((item) => item.parent === page.id)
      .map((item) => ({
        object: 'block',
        id: item.id,
        type: 'child_database',
        child_database: { title: item.title },
        has_children: false,
      })),
  ];
  const parseValue = (type: Kind, raw: unknown): Value => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      const item = raw as Args;
      if (type === 'select' || type === 'status')
        return String(item[type]?.name ?? item.name ?? words(item));
      if (type === 'multi_select')
        return [item.multi_select ?? item].flat().map((entry: Args) => String(entry.name ?? entry));
      if (type === 'date') return String(item.date?.start ?? item.start ?? words(item));
      if (type === 'number') return Number(item.number ?? words(item));
      if (type === 'checkbox') return Boolean(item.checkbox);
      return words(item[type] ?? item);
    }
    if (type === 'number') return Number(raw);
    if (type === 'checkbox') return raw === true || String(raw).toLowerCase() === 'true';
    if (type === 'multi_select' || type === 'people')
      return Array.isArray(raw)
        ? raw.map(String)
        : String(raw)
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);
    return Array.isArray(raw) ? raw.map(String).join(', ') : String(raw);
  };
  const setProperties = (page: StoredPage, input: unknown) => {
    const database = page.database ? findDatabase(page.database) : undefined;
    const entries: Array<[string, unknown]> = Array.isArray(input)
      ? input.map((item: Args) => [String(item.name), item.value])
      : Object.entries((input ?? {}) as Args);
    for (const [name, raw] of entries) {
      if (!database) {
        if (name.toLowerCase() === 'title') page.title = parseValue('title', raw) as string;
        else throw new Error(`${name} is not a property that exists.`);
        continue;
      }
      const schema = database.schema[name];
      if (!schema) throw new Error(`${name} is not a property that exists.`);
      const value = parseValue(schema.type, raw);
      if (schema.type === 'status' && value && !schema.options?.includes(String(value)))
        throw new Error(
          `Invalid status option "${value}". Options: ${(schema.options ?? []).join(', ')}.`,
        );
      if (schema.type === 'select' && value && !schema.options?.includes(String(value)))
        (schema.options ??= []).push(String(value));
      page.properties = { ...page.properties, [name]: value };
      if (schema.type === 'title') page.title = String(value ?? '');
    }
    page.edited = now();
  };
  const create = (parent: string, title: string, markdown = '') => {
    const database = databases.find((item) => item.id === parent);
    const page: StoredPage = {
      id: randomUUID(),
      parent,
      title,
      markdown,
      archived: false,
      edited: now(),
      ...(database ? { database: database.id, properties: { [titleOf(database)]: title } } : {}),
    };
    pages.push(page);
    return page;
  };
  const search = (args: Args) => {
    const query = String(args.query ?? '').toLowerCase();
    const filter = String(args.filter_value ?? args.filter?.value ?? '');
    return [
      ...(filter === 'page' ? [] : databases)
        .filter((item) => item.title.toLowerCase().includes(query))
        .map(databaseView),
      ...(filter === 'database' ? [] : pages)
        .filter((item) => !item.archived && item.title.toLowerCase().includes(query))
        .sort((a, b) => b.edited - a.edited)
        .map(pageView),
    ].slice(0, Number(args.page_size ?? 50));
  };
  const tools: Tool[] = [
    {
      slug: 'NOTION_SEARCH_NOTION_PAGE',
      description:
        'Search pages and databases by title. filter_value "page" or "database" limits the kind; an empty query lists everything shared with the integration.',
      inputSchema: obj({
        query: str('Text to find in titles.'),
        filter_value: str('page or database.'),
        page_size: num('Maximum results.'),
      }),
      run: (args) => ({ results: search(args), has_more: false }),
    },
    {
      slug: 'NOTION_FETCH_DATA',
      description: 'List or search pages and databases. fetch_type is pages, databases or all.',
      inputSchema: obj(
        { fetch_type: str('pages, databases or all.'), query: str('Text to find in titles.') },
        ['fetch_type'],
      ),
      run: (args) => ({
        values: search({
          query: args.query,
          filter_value:
            args.fetch_type === 'pages'
              ? 'page'
              : args.fetch_type === 'databases'
                ? 'database'
                : '',
        }).map((item: Args) => ({
          id: item.id,
          object: item.object,
          title:
            item.object === 'database'
              ? words(item.title)
              : (pages.find((page) => page.id === item.id)?.title ?? ''),
          url: item.url,
        })),
      }),
    },
    {
      slug: 'NOTION_GET_PAGE_MARKDOWN',
      description: "Return a page's full content as Markdown.",
      inputSchema: obj({ page_id: str('Page ID.') }, ['page_id']),
      run(args) {
        const page = findPage(args.page_id);
        return { page_id: page.id, title: page.title, markdown: page.markdown };
      },
    },
    {
      slug: 'NOTION_FETCH_BLOCK_CONTENTS',
      description: 'Fetch the first-level child blocks of a page or block, including child pages.',
      inputSchema: obj({ block_id: str('Page or block ID.') }, ['block_id']),
      run: (args) => ({ results: blocks(findPage(args.block_id)), has_more: false }),
    },
    {
      slug: 'NOTION_RETRIEVE_PAGE',
      description: "Retrieve a page's properties and metadata, not its content.",
      inputSchema: obj({ page_id: str('Page ID.') }, ['page_id']),
      run: (args) => pageView(findPage(args.page_id)),
    },
    {
      slug: 'NOTION_FETCH_DATABASE',
      description: "Fetch a database's title and property schema, including select options.",
      inputSchema: obj({ database_id: str('Database ID.') }, ['database_id']),
      run: (args) => databaseView(findDatabase(args.database_id)),
    },
    {
      slug: 'NOTION_QUERY_DATABASE',
      description: 'Query the rows of a database. Each row is a page with property values.',
      inputSchema: obj(
        {
          database_id: str('Database ID.'),
          page_size: num('Maximum rows.'),
          sorts: list({ type: 'object' }, 'Sort instructions.'),
        },
        ['database_id'],
      ),
      run(args) {
        const database = findDatabase(args.database_id);
        return {
          results: pages
            .filter((page) => page.database === database.id && !page.archived)
            .slice(0, Number(args.page_size ?? 100))
            .map(pageView),
          has_more: false,
        };
      },
    },
    {
      slug: 'NOTION_INSERT_ROW_DATABASE',
      description:
        'Create a row in a database. properties is a list of {name, type, value}, with name exactly as in the schema and value as text (dates as YYYY-MM-DD, select and status as the option name).',
      inputSchema: obj(
        {
          database_id: str('Database ID.'),
          properties: list(
            obj({ name: str('Property name.'), type: str('Property type.'), value: str('Value.') }),
            'Property values.',
          ),
          child_blocks: list({ type: 'object' }, 'Content blocks for the row page.'),
        },
        ['database_id'],
      ),
      write: 'create',
      run(args) {
        const database = findDatabase(args.database_id);
        const page = create(database.id, '');
        page.properties = {};
        try {
          setProperties(page, args.properties);
        } catch (error) {
          pages.splice(pages.indexOf(page), 1);
          throw error;
        }
        if (args.child_blocks) append(page.id, args.child_blocks);
        return pageView(page);
      },
    },
    {
      slug: 'NOTION_UPDATE_ROW_DATABASE',
      description:
        'Update a database row. properties is a list of {name, type, value}; omitted properties stay unchanged. Set delete_row to archive the row.',
      inputSchema: obj(
        {
          row_id: str('Row page ID.'),
          properties: list(
            obj({ name: str('Property name.'), type: str('Property type.'), value: str('Value.') }),
            'Property values.',
          ),
          delete_row: { type: 'boolean' },
        },
        ['row_id'],
      ),
      write: 'update',
      run(args) {
        const page = findPage(args.row_id);
        if (!page.database) throw new Error('The page is not a database row.');
        const before = structuredClone(page);
        try {
          if (args.properties) setProperties(page, args.properties);
        } catch (error) {
          Object.assign(page, before);
          throw error;
        }
        if (args.delete_row) page.archived = true;
        return pageView(page);
      },
    },
    {
      slug: 'NOTION_UPDATE_PAGE',
      description: "Update a page's properties in Notion API format, or archive it.",
      inputSchema: obj(
        {
          page_id: str('Page ID.'),
          properties: { type: 'object', description: 'Property values in Notion API format.' },
          archived: { type: 'boolean' },
        },
        ['page_id'],
      ),
      write: 'update',
      run(args) {
        const page = findPage(args.page_id);
        const before = structuredClone(page);
        try {
          if (args.properties) setProperties(page, args.properties);
        } catch (error) {
          Object.assign(page, before);
          throw error;
        }
        if (args.archived !== undefined) page.archived = Boolean(args.archived);
        return pageView(page);
      },
    },
    {
      slug: 'NOTION_CREATE_NOTION_PAGE',
      description:
        'Create a page under a parent page, or a row when the parent is a database. markdown fills its content.',
      inputSchema: obj(
        {
          parent_id: str('Parent page or database ID.'),
          title: str('Page title.'),
          markdown: str('Page content as Markdown.'),
        },
        ['parent_id', 'title'],
      ),
      write: 'create',
      run(args) {
        const key = bare(args.parent_id);
        const database = databases.find((item) => bare(item.id) === key);
        const parent = database?.id ?? findPage(args.parent_id).id;
        return pageView(
          create(parent, String(args.title ?? ''), String(args.markdown ?? args.content ?? '')),
        );
      },
    },
    {
      slug: 'NOTION_ADD_MULTIPLE_PAGE_CONTENT',
      description:
        'Append content blocks to a page. Each item is {content_block: {block_property, content}}, for example block_property paragraph, heading_2, bulleted_list_item or to_do.',
      inputSchema: obj(
        {
          parent_block_id: str('Page ID.'),
          content_blocks: list({ type: 'object' }, 'Blocks to append.'),
        },
        ['parent_block_id', 'content_blocks'],
      ),
      write: 'update',
      run(args) {
        const page = append(args.parent_block_id, args.content_blocks);
        return { page_id: page.id, markdown: page.markdown };
      },
    },
    {
      slug: 'NOTION_APPEND_TEXT_BLOCKS',
      description: 'Append paragraph, heading and list blocks, in Notion block format, to a page.',
      inputSchema: obj(
        { block_id: str('Page ID.'), children: list({ type: 'object' }, 'Notion blocks.') },
        ['block_id', 'children'],
      ),
      write: 'update',
      run(args) {
        const page = append(args.block_id, args.children);
        return { page_id: page.id, markdown: page.markdown };
      },
    },
    {
      slug: 'NOTION_APPEND_TASK_BLOCKS',
      description: 'Append to_do, toggle and callout blocks, in Notion block format, to a page.',
      inputSchema: obj(
        { block_id: str('Page ID.'), children: list({ type: 'object' }, 'Notion blocks.') },
        ['block_id', 'children'],
      ),
      write: 'update',
      run(args) {
        const page = append(args.block_id, args.children);
        return { page_id: page.id, markdown: page.markdown };
      },
    },
    {
      slug: 'NOTION_ARCHIVE_NOTION_PAGE',
      description: 'Archive a page, or restore it with archive false.',
      inputSchema: obj({ page_id: str('Page ID.'), archive: { type: 'boolean' } }, ['page_id']),
      write: 'delete',
      run(args) {
        const page = findPage(args.page_id);
        page.archived = args.archive !== false;
        page.edited = now();
        return pageView(page);
      },
    },
    {
      slug: 'NOTION_CREATE_COMMENT',
      description: 'Add a comment to a page.',
      inputSchema: obj({ page_id: str('Page ID.'), comment: str('Comment text.') }, [
        'page_id',
        'comment',
      ]),
      write: 'post',
      run(args) {
        const page = findPage(args.page_id ?? args.parent_page_id);
        const comment = {
          id: randomUUID(),
          page: page.id,
          text: words(args.comment),
          at: now(),
        };
        if (!comment.text.trim()) throw new Error('The comment is empty.');
        comments.push(comment);
        return { object: 'comment', id: comment.id, created_time: iso(comment.at) };
      },
    },
    {
      slug: 'NOTION_FETCH_COMMENTS',
      description: 'Fetch the comments on a page.',
      inputSchema: obj({ page_id: str('Page ID.') }, ['page_id']),
      run(args) {
        const page = findPage(args.page_id ?? args.block_id);
        return {
          results: comments
            .filter((item) => item.page === page.id)
            .map((item) => ({
              id: item.id,
              rich_text: rich(item.text),
              created_time: iso(item.at),
            })),
        };
      },
    },
    {
      slug: 'NOTION_LIST_USERS',
      description: 'List the users of the workspace.',
      inputSchema: obj({}),
      run: () => ({
        results: [
          { object: 'user', id: 'owner', name: owner.name, person: { email: owner.email } },
        ],
      }),
    },
  ];
  return { tools, pages, databases, comments };
}

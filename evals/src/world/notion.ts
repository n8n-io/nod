import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { iso, list, obj, str, words } from './app-kit.ts';
import type { McpTool } from './mcp.ts';

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

const bare = (value: unknown) =>
  String(value ?? '')
    .replace(/^collection:\/\//, '')
    .replace(/-/g, '')
    .toLowerCase();
const url = (id: string) => `https://www.notion.so/${id.replaceAll('-', '')}`;

export function notion(
  owner: { name: string; email: string },
  seed: { pages?: NotionPage[]; databases?: NotionDatabase[] },
  now: () => number,
) {
  const databases = (seed.databases ?? []).map((database) => ({
    ...database,
    id: database.id ?? randomUUID(),
    source: randomUUID(),
    parent: database.parent ?? 'workspace',
    schema: structuredClone(database.schema),
  }));
  type Database = (typeof databases)[number];
  const titleOf = (database: Database) =>
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
  const people = [{ id: randomUUID(), name: owner.name, email: owner.email }];
  const findPage = (id: unknown) => {
    const key = bare(id);
    const page = pages.find(
      (item) => key && (bare(item.id) === key || key.endsWith(bare(item.id))),
    );
    if (!page) throw new Error(`Could not find page with ID: ${id}`);
    return page;
  };
  const findDatabase = (id: unknown) => {
    const key = bare(id);
    return databases.find(
      (item) =>
        key &&
        [item.id, item.source].some((value) => bare(value) === key || key.endsWith(bare(value))),
    );
  };
  const ancestors = (parent: string): string[] => {
    if (parent === 'workspace') return [];
    const database = databases.find((item) => item.id === parent);
    if (database)
      return [
        ...ancestors(database.parent),
        `<database url="${url(database.id)}" title="${database.title}"/>`,
      ];
    const page = pages.find((item) => item.id === parent);
    return page
      ? [...ancestors(page.parent), `<parent-page url="${url(page.id)}" title="${page.title}"/>`]
      : [];
  };
  const columns = (database: Database) =>
    Object.entries(database.schema).flatMap(([name, item]) =>
      item.type === 'date'
        ? [`date:${name}:start`, `date:${name}:end`, `date:${name}:is_datetime`]
        : [name],
    );
  const sqlValue = (database: Database, page: StoredPage, column: string) => {
    if (column === 'url') return url(page.id);
    if (column === 'createdTime') return iso(page.edited);
    const date = /^date:(.+):(start|end|is_datetime)$/.exec(column);
    if (date) {
      const value = page.properties?.[date[1]];
      if (date[2] === 'start') return value ? String(value) : null;
      if (date[2] === 'end') return null;
      return value ? (String(value).includes('T') ? 1 : 0) : null;
    }
    const value = page.properties?.[column] ?? null;
    const type = database.schema[column]?.type;
    if (value === null) return null;
    if (type === 'checkbox') return value ? '__YES__' : '__NO__';
    if (type === 'number') return Number(value);
    if (Array.isArray(value)) return JSON.stringify(value);
    return String(value);
  };
  const propertiesView = (page: StoredPage) => {
    const database = page.database
      ? databases.find((item) => item.id === page.database)
      : undefined;
    if (!database) return { title: page.title };
    return Object.fromEntries(
      columns(database)
        .map((column) => [column, sqlValue(database, page, column)])
        .filter(([, value]) => value !== null),
    );
  };
  const sourceView = (database: Database) =>
    `<data-source url="collection://${database.source}">\n<data-source-state>\n${JSON.stringify(
      {
        name: database.title,
        schema: Object.fromEntries(
          Object.entries(database.schema).map(([name, item]) => [
            name,
            {
              name,
              type: item.type,
              ...(item.options
                ? { options: item.options.map((option) => ({ name: option })) }
                : {}),
            },
          ]),
        ),
      },
      null,
      2,
    )}\n</data-source-state>\n<sqlite-table>\nCREATE TABLE "collection://${database.source}" (\n  "url" TEXT UNIQUE,\n  "createdTime" TEXT,\n${columns(
      database,
    )
      .map((column) => {
        const type = database.schema[column]?.type;
        return `  "${column}" ${type === 'number' || column.endsWith(':is_datetime') ? 'INTEGER' : 'TEXT'}`;
      })
      .join(',\n')}\n)\n</sqlite-table>\n</data-source>`;
  const fetchPage = (page: StoredPage) => {
    const children = [
      ...pages
        .filter((item) => item.parent === page.id && !item.archived && !item.database)
        .map((item) => `<page url="${url(item.id)}">${item.title}</page>`),
      ...databases
        .filter((item) => item.parent === page.id)
        .map((item) => `<database url="${url(item.id)}" inline="false">${item.title}</database>`),
    ];
    return [
      `Here is the result of "view" for the Page with URL ${url(page.id)} as of ${iso(page.edited)}:`,
      `<page url="${url(page.id)}"${page.archived ? ' in-trash="true"' : ''}>`,
      `<ancestor-path>\n${ancestors(page.parent).reverse().join('\n')}\n</ancestor-path>`,
      `<properties>\n${JSON.stringify(propertiesView(page))}\n</properties>`,
      `<content>\n${[page.markdown, ...children].filter(Boolean).join('\n')}\n</content>`,
      '</page>',
    ].join('\n');
  };
  const parseValue = (database: Database, name: string, raw: unknown): Value => {
    const schema = database.schema[name];
    if (!schema) throw new Error(`Property "${name}" does not exist in this data source.`);
    if (raw === null || raw === undefined) return null;
    if (schema.type === 'number') {
      const value = Number(raw);
      if (Number.isNaN(value)) throw new Error(`Property "${name}" expects a number.`);
      return value;
    }
    if (schema.type === 'checkbox') return raw === true || raw === '__YES__' || raw === 'true';
    if (schema.type === 'multi_select' || schema.type === 'people') {
      if (Array.isArray(raw)) return raw.map(String);
      try {
        const parsed = JSON.parse(String(raw));
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {}
      return String(raw)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
    const value = typeof raw === 'object' ? words(raw) : String(raw);
    if (schema.type === 'status' && !schema.options?.includes(value))
      throw new Error(
        `Invalid status option "${value}" for "${name}". Options: ${(schema.options ?? []).join(', ')}.`,
      );
    if (schema.type === 'select' && schema.options && !schema.options.includes(value))
      schema.options.push(value);
    return value;
  };
  const setProperties = (page: StoredPage, input: Record<string, unknown>) => {
    const database = page.database
      ? databases.find((item) => item.id === page.database)
      : undefined;
    const next = { ...page.properties };
    let title = page.title;
    for (const [key, raw] of Object.entries(input ?? {})) {
      if (!database) {
        if (key.toLowerCase() !== 'title')
          throw new Error(`Pages outside a database only have a "title" property, not "${key}".`);
        title = String(raw ?? '');
        continue;
      }
      const date = /^date:(.+):(start|end|is_datetime)$/.exec(key);
      if (date) {
        if (database.schema[date[1]]?.type !== 'date')
          throw new Error(`Property "${date[1]}" is not a date property.`);
        if (date[2] === 'start') next[date[1]] = raw === null ? null : String(raw);
        continue;
      }
      const name = key.replace(/^userDefined:/, '');
      if (database.schema[name]?.type === 'date')
        throw new Error(`Set date property "${name}" with "date:${name}:start".`);
      next[name] = parseValue(database, name, raw);
      if (database.schema[name].type === 'title') title = String(next[name] ?? '');
    }
    page.properties = database ? next : page.properties;
    page.title = title;
    page.edited = now();
  };
  const search = (query: string, limit: number) => {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 1);
    const score = (title: string, body: string) =>
      terms.length
        ? terms.reduce(
            (total, term) =>
              total +
              (title.toLowerCase().includes(term) ? 3 : 0) +
              (body.toLowerCase().includes(term) ? 1 : 0),
            0,
          )
        : 1;
    return [
      ...databases.map((item) => ({
        id: item.id,
        title: item.title,
        url: url(item.id),
        type: 'database',
        highlight: '',
        timestamp: iso(now() - 86_400_000),
        score: score(item.title, ''),
      })),
      ...pages
        .filter((item) => !item.archived)
        .map((item) => ({
          id: item.id,
          title: item.title,
          url: url(item.id),
          type: 'page',
          highlight: item.markdown.replace(/\s+/g, ' ').slice(0, 200),
          timestamp: iso(item.edited),
          score: score(item.title, item.markdown),
        })),
    ]
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit)
      .map(({ score: _score, ...item }) => item);
  };
  const create = (parent: string, database: Database | undefined, input: Record<string, any>) => {
    const page: StoredPage = {
      id: randomUUID(),
      parent,
      title: '',
      markdown: String(input.content ?? ''),
      archived: false,
      edited: now(),
      ...(database ? { database: database.id, properties: {} } : {}),
    };
    setProperties(page, input.properties ?? {});
    if (!page.title && !database)
      throw new Error('A page outside a database needs a "title" property.');
    pages.push(page);
    return page;
  };
  const query = (data: Record<string, any>) => {
    if (data.mode === 'view')
      throw new Error('Saved views are not available in this workspace. Use sql or rows mode.');
    const urls: string[] =
      data.mode === 'rows' ? [data.data_source_url] : (data.data_source_urls ?? []);
    const sources = urls.map((value) => {
      const database = findDatabase(value);
      if (!database)
        throw new Error(`Could not find data source: ${value}. Fetch the database first.`);
      return database;
    });
    const db = new DatabaseSync(':memory:');
    try {
      for (const database of sources) {
        const cols = ['url', 'createdTime', ...columns(database)];
        db.exec(
          `CREATE TABLE "collection://${database.source}" (${cols.map((column) => `"${column}"`).join(', ')})`,
        );
        const insert = db.prepare(
          `INSERT INTO "collection://${database.source}" VALUES (${cols.map(() => '?').join(', ')})`,
        );
        for (const page of pages.filter((item) => item.database === database.id && !item.archived))
          insert.run(
            ...cols.map((column) => sqlValue(database, page, column) as string | number | null),
          );
      }
      db.exec('PRAGMA query_only = ON');
      if (data.mode === 'rows') {
        const database = sources[0];
        const rows = db.prepare(`SELECT * FROM "collection://${database.source}"`).all() as Array<
          Record<string, unknown>
        >;
        const test = (row: Record<string, unknown>, filter: Record<string, any>): boolean => {
          if (filter.type === 'group')
            return filter.operator === 'or'
              ? filter.filters.some((item: any) => test(row, item))
              : filter.filters.every((item: any) => test(row, item));
          const value =
            database.schema[filter.property]?.type === 'date'
              ? row[`date:${filter.property}:start`]
              : row[filter.property];
          const wanted = filter.value?.value;
          const text = String(value ?? '');
          switch (filter.operator) {
            case 'is_empty':
              return value === null || value === '';
            case 'is_not_empty':
              return value !== null && value !== '';
            case 'string_is':
            case 'enum_is':
            case 'status_is':
              return text.toLowerCase() === String(wanted).toLowerCase();
            case 'string_is_not':
            case 'enum_is_not':
            case 'status_is_not':
              return text.toLowerCase() !== String(wanted).toLowerCase();
            case 'string_contains':
            case 'enum_contains':
              return text.toLowerCase().includes(String(wanted).toLowerCase());
            case 'checkbox_is':
              return (text === '__YES__') === Boolean(wanted);
            case 'date_is':
              return text.slice(0, 10) === String(wanted).slice(0, 10);
            case 'date_is_before':
              return Boolean(text) && text.slice(0, 10) < String(wanted).slice(0, 10);
            case 'date_is_after':
              return Boolean(text) && text.slice(0, 10) > String(wanted).slice(0, 10);
            case 'date_is_on_or_before':
              return Boolean(text) && text.slice(0, 10) <= String(wanted).slice(0, 10);
            case 'date_is_on_or_after':
              return Boolean(text) && text.slice(0, 10) >= String(wanted).slice(0, 10);
            case 'number_equals':
              return value !== null && value !== '' && Number(value) === Number(wanted);
            default:
              throw new Error(`Unsupported filter operator: ${filter.operator}`);
          }
        };
        const filtered = rows.filter((row) => !data.filter || test(row, data.filter));
        for (const sort of [...(data.sort ?? [])].reverse())
          filtered.sort(
            (a, b) =>
              String(a[sort.property] ?? '').localeCompare(String(b[sort.property] ?? '')) *
              (sort.direction === 'descending' ? -1 : 1),
          );
        return { results: filtered.slice(0, Number(data.limit ?? 50)), has_more: false };
      }
      const sql = String(data.query ?? '').trim();
      if (!/^(select|with)\b/i.test(sql))
        throw new Error('Only read-only SELECT queries are allowed.');
      const results = db
        .prepare(sql)
        .all(...((data.params ?? []) as Array<string | number | null>));
      return { results, has_more: false };
    } finally {
      db.close();
    }
  };
  const tools: McpTool[] = [
    {
      name: 'notion-search',
      description:
        'Search Notion with AI search over page titles and content. Start with {"query":"..."}. Use query_type "user" to find people.',
      inputSchema: obj(
        {
          query: str('Short, specific keywords for Notion content search.'),
          query_type: { type: 'string', enum: ['internal', 'user'] },
          page_size: { type: 'integer', minimum: 1, maximum: 50 },
        },
        ['query'],
      ),
      run(args) {
        if (args.query_type === 'user')
          return {
            results: people
              .filter((item) =>
                `${item.name} ${item.email}`
                  .toLowerCase()
                  .includes(String(args.query).toLowerCase()),
              )
              .map((item) => ({ id: item.id, title: item.name, email: item.email, type: 'user' })),
          };
        return {
          results: search(String(args.query ?? ''), Number(args.page_size ?? 10)),
          type: 'workspace_search',
        };
      },
    },
    {
      name: 'notion-fetch',
      description:
        'Retrieves details about a Notion page, database or data source by URL or ID. Pages use enhanced Markdown. Databases return data sources in <data-source url="collection://..."> tags with their SQLite schema; query rows with query_data_sources.',
      inputSchema: obj({ id: str('The ID or URL of the Notion page, database, or data source.') }, [
        'id',
      ]),
      run(args) {
        const database = findDatabase(args.id);
        if (database && String(args.id).startsWith('collection://')) return sourceView(database);
        if (database)
          return [
            `Here is the result of "view" for the Database with URL ${url(database.id)}:`,
            `<database url="${url(database.id)}">`,
            `<ancestor-path>\n${ancestors(database.parent).reverse().join('\n')}\n</ancestor-path>`,
            `<title>${database.title}</title>`,
            `<data-sources>\n${sourceView(database)}\n</data-sources>`,
            '</database>',
          ].join('\n');
        return fetchPage(findPage(args.id));
      },
    },
    {
      name: 'notion-query-data-sources',
      description:
        'Query Notion data sources using read-only SQLite (mode "sql", default) or structured rows (mode "rows"). Fetch first to read the schema and collection:// URL. Date properties expand to "date:<Name>:start". Checkbox values are "__YES__" and "__NO__".',
      inputSchema: obj(
        {
          data: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['sql', 'rows', 'view'] },
              data_source_urls: list({ type: 'string' }, 'collection:// URLs available as tables.'),
              query: str('Read-only SQLite query, e.g. SELECT * FROM "collection://..." WHERE ...'),
              params: list({}, 'Positional parameters for ? placeholders.'),
              data_source_url: str('For rows mode: one collection:// URL.'),
              filter: { type: 'object' },
              sort: list({ type: 'object' }, 'For rows mode.'),
              limit: { type: 'integer' },
            },
          },
        },
        ['data'],
      ),
      run: (args) => query(args.data ?? {}),
    },
    {
      name: 'notion-create-pages',
      description:
        'Creates one or more Notion pages. For a database destination, fetch first and use its collection:// URL as data_source_id with exact property names. Outside a database the only property is "title". Date properties use "date:{property}:start"; checkboxes use "__YES__"/"__NO__".',
      inputSchema: obj(
        {
          pages: list(
            obj({
              properties: { type: 'object' },
              content: str('Page content in Notion Markdown.'),
            }),
            'The pages to create.',
          ),
          parent: { type: 'object', description: '{page_id}, {database_id} or {data_source_id}.' },
        },
        ['pages'],
      ),
      write: 'create',
      run(args) {
        const parent = args.parent ?? {};
        const database = findDatabase(parent.data_source_id ?? parent.database_id);
        if ((parent.data_source_id || parent.database_id) && !database)
          throw new Error('Could not find the parent database or data source.');
        const parentId =
          database?.id ?? (parent.page_id ? findPage(parent.page_id).id : 'workspace');
        const created = [args.pages ?? []]
          .flat()
          .map((input: Record<string, any>) => create(parentId, database, input));
        return {
          pages: created.map((page) => ({
            id: page.id,
            url: url(page.id),
            properties: propertiesView(page),
          })),
        };
      },
    },
    {
      name: 'notion-update-page',
      description:
        "Update a Notion page's properties or content. command is update_properties (properties), insert_content (content, position start or end), update_content (content_updates of old_str/new_str) or replace_content (new_str).",
      inputSchema: obj(
        {
          page_id: str('The ID of the page to update.'),
          command: {
            type: 'string',
            enum: ['update_properties', 'update_content', 'replace_content', 'insert_content'],
          },
          properties: { type: 'object' },
          content: str('For insert_content.'),
          position: { type: 'object' },
          content_updates: list(
            obj({ old_str: str('Exact text.'), new_str: str('Replacement.') }),
            'For update_content.',
          ),
          new_str: str('For replace_content.'),
        },
        ['page_id', 'command'],
      ),
      write: 'update',
      run(args) {
        const page = findPage(args.page_id);
        if (page.archived) throw new Error('The page is in the trash.');
        const before = structuredClone(page);
        try {
          if (args.command === 'update_properties') setProperties(page, args.properties ?? {});
          else if (args.command === 'insert_content') {
            const content = String(args.content ?? '');
            page.markdown =
              args.position?.type === 'start'
                ? [content, page.markdown].filter(Boolean).join('\n')
                : [page.markdown, content].filter(Boolean).join('\n');
          } else if (args.command === 'update_content') {
            for (const update of args.content_updates ?? []) {
              const count = page.markdown.split(update.old_str).length - 1;
              if (!count) throw new Error(`old_str not found: ${update.old_str}`);
              if (count > 1 && !update.replace_all_matches)
                throw new Error(
                  `old_str matches ${count} times; make it unique or set replace_all_matches.`,
                );
              page.markdown = update.replace_all_matches
                ? page.markdown.split(update.old_str).join(update.new_str)
                : page.markdown.replace(update.old_str, update.new_str);
            }
          } else if (args.command === 'replace_content') page.markdown = String(args.new_str ?? '');
          else throw new Error(`Unsupported command: ${args.command}`);
        } catch (error) {
          Object.assign(page, before);
          throw error;
        }
        page.edited = now();
        return { page_id: page.id, url: url(page.id) };
      },
    },
    {
      name: 'notion-move-pages',
      description: 'Move one or more Notion pages to a new parent page or database.',
      inputSchema: obj(
        {
          page_or_database_ids: list({ type: 'string' }, 'Page IDs to move.'),
          new_parent: {
            type: 'object',
            description: '{page_id}, {database_id} or {type:"workspace"}.',
          },
        },
        ['page_or_database_ids', 'new_parent'],
      ),
      write: 'update',
      run(args) {
        const target = args.new_parent ?? {};
        const database = findDatabase(target.data_source_id ?? target.database_id);
        if ((target.data_source_id || target.database_id) && !database)
          throw new Error('Could not find the new parent database or data source.');
        const parent = database?.id ?? (target.page_id ? findPage(target.page_id).id : 'workspace');
        const moved = [args.page_or_database_ids ?? []].flat().map(findPage);
        for (const page of moved) {
          page.parent = parent;
          page.database = database?.id;
          page.edited = now();
        }
        return { moved: moved.map((page) => page.id) };
      },
    },
    {
      name: 'notion-delete-pages',
      description:
        'Move Notion pages to Trash. Use only when the user explicitly asks to delete specific pages. Without user_confirmed: true, nothing is trashed and the error lists what would be moved to Trash.',
      inputSchema: obj(
        {
          page_ids: list({ type: 'string' }, 'IDs of the pages to move to Trash.'),
          user_confirmed: { type: 'boolean' },
        },
        ['page_ids'],
      ),
      write: 'delete',
      run(args) {
        const targets = [args.page_ids ?? []].flat().map(findPage);
        if (args.user_confirmed !== true)
          throw new Error(
            `Nothing was moved to Trash. These pages would be: ${targets.map((page) => page.title).join(', ')}. Confirm with the user, then retry with user_confirmed: true.`,
          );
        for (const page of targets) {
          page.archived = true;
          page.edited = now();
        }
        return { trashed: targets.map((page) => ({ id: page.id, title: page.title })) };
      },
    },
    {
      name: 'notion-create-comment',
      description: 'Add a top-level comment to a page. Provide page_id and markdown.',
      inputSchema: obj(
        { page_id: str('The page to comment on.'), markdown: str('Comment text.') },
        ['page_id'],
      ),
      write: 'post',
      run(args) {
        const page = findPage(args.page_id);
        const text = String(args.markdown ?? words(args.rich_text ?? '')).trim();
        if (!text) throw new Error('Provide markdown or rich_text.');
        const comment = { id: randomUUID(), page: page.id, text, at: now() };
        comments.push(comment);
        return { id: comment.id, created_time: iso(comment.at) };
      },
    },
    {
      name: 'notion-get-comments',
      description: 'Get comments and discussions from a Notion page.',
      inputSchema: obj({ page_id: str('Identifier for a Notion page.') }, ['page_id']),
      run(args) {
        const page = findPage(args.page_id);
        return (
          comments
            .filter((item) => item.page === page.id)
            .map(
              (item) => `<comment id="${item.id}" created="${iso(item.at)}">${item.text}</comment>`,
            )
            .join('\n') || 'No comments.'
        );
      },
    },
    {
      name: 'notion-get-users',
      description:
        'Retrieves the users in the workspace. Pass user_id "self" for the current user.',
      inputSchema: obj({
        query: str('Filter by name or email.'),
        user_id: str('A user ID, or "self".'),
      }),
      run: (args) => ({
        results: people
          .filter((item) => !args.user_id || args.user_id === 'self' || item.id === args.user_id)
          .filter(
            (item) =>
              !args.query ||
              `${item.name} ${item.email}`.toLowerCase().includes(String(args.query).toLowerCase()),
          )
          .map((item) => ({ id: item.id, type: 'person', name: item.name, email: item.email })),
      }),
    },
  ];
  return { tools, pages, databases, comments };
}

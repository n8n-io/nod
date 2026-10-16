import { id, iso, num, obj, readUploads, str, uploadable, type Tool } from './app-kit.ts';
import { pdf } from './pdf.ts';

export const folderType = 'application/vnd.google-apps.folder';
export const docType = 'application/vnd.google-apps.document';

export interface DriveFile {
  id?: string;
  name: string;
  mimeType: string;
  parents?: string[];
  text?: string;
  bytes?: Buffer;
  modified?: number;
  trashed?: boolean;
  shared?: Array<{ email: string; role: string; type?: string }>;
}

export type StoredFile = Required<Omit<DriveFile, 'text' | 'bytes'>> & {
  text?: string;
  bytes?: Buffer;
};

export interface FileStore {
  files: StoredFile[];
  now(): number;
}

export function fileStore(seed: DriveFile[], now: () => number): FileStore {
  return {
    now,
    files: seed.map((file) => ({
      id: file.id ?? id('f'),
      parents: ['root'],
      modified: now() - 86_400_000,
      trashed: false,
      shared: [],
      ...file,
    })),
  };
}

const content = (file: StoredFile) =>
  file.bytes ?? (file.text === undefined ? undefined : Buffer.from(file.text));

function clauses(query: string) {
  const quoted: string[] = [];
  return query
    .replace(/'(?:\\'|[^'])*'/g, (match) => `'\u0000${quoted.push(match) - 1}'`)
    .replace(/[()]/g, ' ')
    .split(/\s+or\s+/i)
    .map((group) =>
      group
        .split(/\s+and\s+/i)
        .map((part) => part.trim().replace(/'\u0000(\d+)'/g, (_, index) => quoted[Number(index)])),
    );
}

function sorter(orderBy: unknown) {
  const keys = String(orderBy ?? '')
    .split(',')
    .map((part) => part.trim().split(/\s+/))
    .filter(([field]) => field);
  const value = (file: StoredFile, field: string) =>
    /^name/i.test(field)
      ? file.name.toLowerCase()
      : field === 'folder'
        ? Number(file.mimeType !== folderType)
        : file.modified;
  return (a: StoredFile, b: StoredFile) => {
    for (const [field, direction] of keys) {
      const [x, y] = [value(a, field), value(b, field)];
      if (x !== y) return (x < y ? -1 : 1) * (/^desc$/i.test(direction ?? '') ? -1 : 1);
    }
    return keys.length ? 0 : b.modified - a.modified;
  };
}

function test(file: StoredFile, clause: string) {
  const quoted = /'((?:\\'|[^'])*)'/.exec(clause)?.[1]?.replace(/\\'/g, "'") ?? '';
  const value = quoted.toLowerCase();
  if (/^name\s+contains/i.test(clause)) return file.name.toLowerCase().includes(value);
  if (/^name\s*=/i.test(clause)) return file.name.toLowerCase() === value;
  if (/^fulltext\s+contains/i.test(clause))
    return `${file.name} ${file.text ?? ''}`.toLowerCase().includes(value);
  if (/^mimetype\s*!=/i.test(clause)) return file.mimeType.toLowerCase() !== value;
  if (/^mimetype\s*=/i.test(clause)) return file.mimeType.toLowerCase() === value;
  if (/^mimetype\s+contains/i.test(clause)) return file.mimeType.toLowerCase().includes(value);
  if (/in\s+parents/i.test(clause)) return file.parents.includes(quoted);
  if (/^trashed\s*=/i.test(clause)) return String(file.trashed) === /true/i.test(clause).toString();
  if (/^modifiedtime\s*>/i.test(clause)) return file.modified > Date.parse(quoted);
  if (/^modifiedtime\s*</i.test(clause)) return file.modified < Date.parse(quoted);
  return true;
}

export function drive(store: FileStore) {
  const { files, now } = store;
  const find = (fileId: unknown) => {
    const file = files.find((item) => item.id === fileId);
    if (!file) throw new Error(`File not found: ${fileId}.`);
    return file;
  };
  const view = (file: StoredFile) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    parents: file.parents,
    modifiedTime: iso(file.modified),
    trashed: file.trashed,
    ...(content(file) ? { size: String(content(file)!.byteLength) } : {}),
    webViewLink: `https://drive.google.com/${file.mimeType === folderType ? 'drive/folders' : 'file/d'}/${file.id}`,
    permissions: file.shared.map((entry) => ({
      type: entry.type ?? 'user',
      role: entry.role,
      emailAddress: entry.email,
    })),
  });
  const ids = (value: unknown) =>
    [value ?? []]
      .flat()
      .flatMap((item) => String(item).split(','))
      .map((item) => item.trim())
      .filter(Boolean);
  const folder = (folderId: unknown) => {
    if (folderId === undefined || folderId === '' || folderId === 'root') return 'root';
    const target = find(folderId);
    if (target.mimeType !== folderType) throw new Error('The parent is not a folder.');
    return target.id;
  };
  const tools: Tool[] = [
    {
      slug: 'GOOGLEDRIVE_FIND_FILE',
      description:
        "Search files and folders. q uses Drive query syntax, such as name contains 'report' and mimeType = 'application/pdf' and 'FOLDER_ID' in parents.",
      inputSchema: obj({
        q: str('Drive query.'),
        pageSize: num('Maximum results.'),
        orderBy: str('Sort order, e.g. modifiedTime desc.'),
        include_trashed: { type: 'boolean' },
      }),
      run(args) {
        const query = String(args.q ?? args.query ?? '').trim();
        const found = files
          .filter(
            (file) => args.include_trashed || /trashed\s*=\s*true/i.test(query) || !file.trashed,
          )
          .filter(
            (file) =>
              !query ||
              (/[=<>']|\bcontains\b|\bin\s+parents\b/i.test(query)
                ? clauses(query).some((group) => group.every((clause) => test(file, clause)))
                : `${file.name} ${file.text ?? ''}`.toLowerCase().includes(query.toLowerCase())),
          )
          .sort(sorter(args.orderBy ?? args.order_by))
          .slice(0, Number(args.pageSize ?? args.page_size ?? 100));
        return { files: found.map(view) };
      },
    },
    {
      slug: 'GOOGLEDRIVE_FIND_FOLDER',
      description: 'Find folders by name, optionally inside a parent folder.',
      inputSchema: obj({
        name_exact: str('Exact folder name.'),
        name_contains: str('Text in the folder name.'),
        parent_folder_id: str('Parent folder ID.'),
      }),
      run(args) {
        const exact = String(args.name_exact ?? '').toLowerCase();
        const contains = String(args.name_contains ?? '').toLowerCase();
        return {
          folders: files
            .filter((file) => file.mimeType === folderType && !file.trashed)
            .filter((file) => !exact || file.name.toLowerCase() === exact)
            .filter((file) => !contains || file.name.toLowerCase().includes(contains))
            .filter(
              (file) =>
                !args.parent_folder_id || file.parents.includes(String(args.parent_folder_id)),
            )
            .map(view),
        };
      },
    },
    {
      slug: 'GOOGLEDRIVE_GET_FILE_METADATA',
      description: "Get a file's metadata without downloading its content.",
      inputSchema: obj({ fileId: str('File ID.') }, ['fileId']),
      run: (args) => view(find(args.fileId ?? args.file_id)),
    },
    {
      slug: 'GOOGLEDRIVE_DOWNLOAD_FILE',
      description:
        'Download a file. Google Docs are exported as plain text, or as PDF when mime_type is application/pdf.',
      inputSchema: obj(
        { fileId: str('File ID.'), mime_type: str('Export MIME type for Google Docs.') },
        ['fileId'],
      ),
      run(args) {
        const file = find(args.fileId ?? args.file_id);
        if (file.mimeType === folderType) throw new Error('Folders cannot be downloaded.');
        if (file.mimeType === docType) {
          const asPdf = String(args.mime_type ?? '').includes('pdf');
          return {
            downloaded_file_content: {
              name: `${file.name}.${asPdf ? 'pdf' : 'txt'}`,
              mimeType: asPdf ? 'application/pdf' : 'text/plain',
              bytes: new Uint8Array(
                asPdf ? pdf((file.text ?? '').split('\n')) : Buffer.from(file.text ?? ''),
              ),
            },
          };
        }
        const bytes = content(file);
        if (!bytes) throw new Error('The file has no content.');
        return {
          downloaded_file_content: {
            name: file.name,
            mimeType: file.mimeType,
            bytes: new Uint8Array(bytes),
          },
        };
      },
    },
    {
      slug: 'GOOGLEDRIVE_CREATE_FOLDER',
      description: 'Create a folder, optionally inside a parent folder.',
      inputSchema: obj({ name: str('Folder name.'), parent_id: str('Parent folder ID.') }, [
        'name',
      ]),
      write: 'create',
      run(args) {
        const created: StoredFile = {
          id: id('f'),
          name: String(args.name),
          mimeType: folderType,
          parents: [folder(args.parent_id)],
          modified: now(),
          trashed: false,
          shared: [],
        };
        files.push(created);
        return view(created);
      },
    },
    {
      slug: 'GOOGLEDRIVE_CREATE_FILE_FROM_TEXT',
      description: 'Create a file from text content, optionally inside a folder.',
      inputSchema: obj(
        {
          file_name: str('File name.'),
          text_content: str('Text content.'),
          mime_type: str('MIME type, text/plain by default.'),
          parent_id: str('Folder ID.'),
        },
        ['file_name', 'text_content'],
      ),
      write: 'create',
      run(args) {
        const created: StoredFile = {
          id: id('f'),
          name: String(args.file_name),
          mimeType: String(args.mime_type ?? 'text/plain'),
          parents: [folder(args.parent_id)],
          text: String(args.text_content ?? ''),
          modified: now(),
          trashed: false,
          shared: [],
        };
        files.push(created);
        return view(created);
      },
    },
    {
      slug: 'GOOGLEDRIVE_UPLOAD_FILE',
      description: 'Upload a file to Drive, optionally into a folder.',
      inputSchema: obj(
        {
          file_to_upload: uploadable('The file to upload.'),
          folder_to_upload_to: str('Folder ID.'),
        },
        ['file_to_upload'],
      ),
      write: 'create',
      run(args) {
        const [file] = readUploads(args.file_to_upload);
        const created: StoredFile = {
          id: id('f'),
          name: file.name,
          mimeType: file.mimeType,
          parents: [folder(args.folder_to_upload_to)],
          bytes: file.bytes,
          modified: now(),
          trashed: false,
          shared: [],
        };
        files.push(created);
        return view(created);
      },
    },
    {
      slug: 'GOOGLEDRIVE_MOVE_FILE',
      description:
        'Move a file by adding and removing parent folder IDs, comma-separated for several.',
      inputSchema: obj(
        {
          file_id: str('File ID.'),
          add_parents: str('Folder IDs to add.'),
          remove_parents: str('Folder IDs to remove.'),
        },
        ['file_id'],
      ),
      write: 'update',
      run(args) {
        const file = find(args.file_id);
        const adding = ids(args.add_parents).map(folder);
        const removing = new Set(
          args.remove_parents === undefined && adding.length
            ? file.parents
            : ids(args.remove_parents),
        );
        file.parents = [
          ...new Set([...file.parents.filter((parent) => !removing.has(parent)), ...adding]),
        ];
        if (!file.parents.length) file.parents = ['root'];
        file.modified = now();
        return view(file);
      },
    },
    {
      slug: 'GOOGLEDRIVE_UPDATE_FILE_PUT',
      description: "Update a file's metadata, for example set name to rename it.",
      inputSchema: obj({ fileId: str('File ID.'), name: str('New name.') }, ['fileId']),
      write: 'update',
      run(args) {
        const file = find(args.fileId ?? args.file_id);
        if (args.name !== undefined) file.name = String(args.name);
        file.modified = now();
        return view(file);
      },
    },
    {
      slug: 'GOOGLEDRIVE_TRASH_FILE',
      description: 'Move a file or folder to the trash.',
      inputSchema: obj({ file_id: str('File ID.') }, ['file_id']),
      write: 'delete',
      run(args) {
        const file = find(args.file_id);
        file.trashed = true;
        return view(file);
      },
    },
    {
      slug: 'GOOGLEDRIVE_LIST_PERMISSIONS',
      description: 'List who a file is shared with.',
      inputSchema: obj({ fileId: str('File ID.') }, ['fileId']),
      run: (args) => ({ permissions: view(find(args.fileId ?? args.file_id)).permissions }),
    },
    {
      slug: 'GOOGLEDRIVE_CREATE_PERMISSION',
      description:
        'Share a file: give a user (type user, email_address) or anyone a role of reader, commenter or writer.',
      inputSchema: obj(
        {
          file_id: str('File ID.'),
          role: str('reader, commenter, writer or owner.'),
          type: str('user, group, domain or anyone.'),
          email_address: str('Email for type user or group.'),
          send_notification_email: { type: 'boolean' },
        },
        ['file_id', 'role', 'type'],
      ),
      write: 'update',
      run(args) {
        const file = find(args.file_id);
        const role = String(args.role);
        if (
          !['reader', 'commenter', 'writer', 'owner', 'organizer', 'fileOrganizer'].includes(role)
        )
          throw new Error(`Invalid role: ${role}.`);
        const type = String(args.type);
        const email = String(args.email_address ?? args.emailAddress ?? '').toLowerCase();
        if ((type === 'user' || type === 'group') && !email)
          throw new Error('email_address is required for this type.');
        file.shared = [
          ...file.shared.filter((entry) => entry.email !== email || entry.type !== type),
          { email, role, type },
        ];
        return { id: id('p'), type, role, emailAddress: email };
      },
    },
  ];
  return { tools, files };
}

export function docs(store: FileStore) {
  const { files, now } = store;
  const find = (documentId: unknown) => {
    const key = String(documentId ?? '');
    const file = files.find(
      (item) => item.mimeType === docType && (item.id === key || key.includes(`/d/${item.id}`)),
    );
    if (!file) throw new Error(`Requested entity was not found: ${key}.`);
    return file;
  };
  const view = (file: StoredFile) => ({
    documentId: file.id,
    title: file.name,
    body: {
      content: (file.text ?? '').split('\n').map((line) => ({
        paragraph: { elements: [{ textRun: { content: `${line}\n` } }] },
      })),
    },
    revisionId: String(file.modified),
  });
  const create = (title: unknown, text: unknown) => {
    const file: StoredFile = {
      id: id('d'),
      name: String(title ?? 'Untitled document'),
      mimeType: docType,
      parents: ['root'],
      text: String(text ?? ''),
      modified: now(),
      trashed: false,
      shared: [],
    };
    files.push(file);
    return file;
  };
  const tools: Tool[] = [
    {
      slug: 'GOOGLEDOCS_SEARCH_DOCUMENTS',
      description: 'Search Google Docs by name or content.',
      inputSchema: obj({
        query: str('Text to find in the name or content.'),
        max_results: num('Maximum results.'),
      }),
      run(args) {
        const query = String(args.query ?? '').toLowerCase();
        return {
          documents: files
            .filter((file) => file.mimeType === docType && !file.trashed)
            .filter(
              (file) => !query || `${file.name} ${file.text ?? ''}`.toLowerCase().includes(query),
            )
            .sort((a, b) => b.modified - a.modified)
            .slice(0, Number(args.max_results ?? 25))
            .map((file) => ({
              id: file.id,
              name: file.name,
              modifiedTime: iso(file.modified),
              webViewLink: `https://docs.google.com/document/d/${file.id}/edit`,
            })),
        };
      },
    },
    {
      slug: 'GOOGLEDOCS_GET_DOCUMENT_BY_ID',
      description: 'Retrieve a Google Doc by ID or URL, including its body content.',
      inputSchema: obj({ id: str('Document ID or URL.') }, ['id']),
      run: (args) => view(find(args.id ?? args.document_id)),
    },
    {
      slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
      description: 'Return the plain text of a Google Doc.',
      inputSchema: obj({ document_id: str('Document ID.') }, ['document_id']),
      run(args) {
        const file = find(args.document_id ?? args.id);
        return { document_id: file.id, title: file.name, text: file.text ?? '' };
      },
    },
    {
      slug: 'GOOGLEDOCS_CREATE_DOCUMENT',
      description: 'Create a Google Doc with a title and optional initial text.',
      inputSchema: obj({ title: str('Title.'), text: str('Initial text.') }, ['title']),
      write: 'create',
      run: (args) => view(create(args.title, args.text)),
    },
    {
      slug: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
      description: 'Create a Google Doc, optionally filled from Markdown.',
      inputSchema: obj({ title: str('Title.'), markdown_text: str('Markdown content.') }, [
        'title',
      ]),
      write: 'create',
      run: (args) => view(create(args.title, args.markdown_text ?? args.markdown)),
    },
    {
      slug: 'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN',
      description: 'Replace the whole content of a Google Doc with Markdown.',
      inputSchema: obj({ id: str('Document ID.'), markdown: str('New Markdown content.') }, [
        'id',
        'markdown',
      ]),
      write: 'update',
      run(args) {
        const file = find(args.id ?? args.document_id);
        file.text = String(args.markdown ?? '');
        file.modified = now();
        return view(file);
      },
    },
    {
      slug: 'GOOGLEDOCS_INSERT_TEXT_ACTION',
      description:
        'Insert text at a 1-based character index, or append it to the end of the document.',
      inputSchema: obj(
        {
          document_id: str('Document ID.'),
          text_to_insert: str('Text to insert.'),
          insertion_index: num('1-based index; omit to append.'),
          append_to_end: { type: 'boolean' },
        },
        ['document_id', 'text_to_insert'],
      ),
      write: 'update',
      run(args) {
        const file = find(args.document_id);
        const text = file.text ?? '';
        const at =
          args.insertion_index === undefined || args.append_to_end
            ? text.length
            : Math.min(Math.max(Number(args.insertion_index) - 1, 0), text.length);
        file.text = text.slice(0, at) + String(args.text_to_insert ?? '') + text.slice(at);
        file.modified = now();
        return { documentId: file.id, replies: [{}] };
      },
    },
    {
      slug: 'GOOGLEDOCS_REPLACE_ALL_TEXT',
      description: 'Replace every occurrence of a text in a Google Doc.',
      inputSchema: obj(
        {
          document_id: str('Document ID.'),
          find_text: str('Text to find.'),
          replace_text: str('Replacement.'),
          match_case: { type: 'boolean' },
        },
        ['document_id', 'find_text', 'replace_text'],
      ),
      write: 'update',
      run(args) {
        const file = find(args.document_id);
        const needle = String(args.find_text ?? '');
        if (!needle) throw new Error('find_text must not be empty.');
        const pattern = new RegExp(
          needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          args.match_case === false ? 'gi' : 'g',
        );
        const text = file.text ?? '';
        const count = [...text.matchAll(pattern)].length;
        file.text = text.replace(pattern, String(args.replace_text ?? ''));
        if (count) file.modified = now();
        return {
          documentId: file.id,
          replies: [{ replaceAllText: { occurrencesChanged: count } }],
        };
      },
    },
  ];
  return { tools, files };
}

export function folderNamed(store: { files: StoredFile[] }, name: string) {
  return store.files.find((file) => file.mimeType === folderType && file.name === name);
}

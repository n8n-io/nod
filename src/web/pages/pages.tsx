import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { pageSorts, pageTypes, type PageSort, type PageType } from '../../shared/attachment-kind';
import type { Page, PageVersion } from '../../shared/contracts';
import { ActionMenu, ActionMenuItem } from '../components/action-menu';
import { useArtifactDrawer } from '../components/artifact-context';
import { ArtifactWorkspace } from '../components/artifact-drawer';
import { DataThumbnail, thumbnailKinds } from '../components/attachment-card';
import { FileGlyph } from '../components/attachment-glyph';
import type { ImagePreview } from '../components/attachment-images';
import {
  FileImage,
  FileSpreadsheet,
  FileText,
  Filter,
  Folder,
  LayoutGrid,
  List,
  Presentation,
  Trash2,
  type IconComponent,
} from '../components/icons';
import { PageTitle } from '../components/page-title';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Loading,
  Notice,
  SearchField,
} from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage } from '../lib/api';
import { attachmentKind } from '../lib/attachment-kind';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import { navigate } from '../lib/navigation';
import { readUiPreference, writeUiPreference } from '../lib/ui-preferences';
import './pages.css';

type ThumbnailKind = ComponentProps<typeof DataThumbnail>['kind'];

const typeLabels: Record<PageType, string> = {
  docs: 'Docs',
  slides: 'Slides',
  data: 'Data',
  images: 'Images',
  files: 'Files',
};
const sortLabels: Record<PageSort, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  title: 'Title, A to Z',
};
const typeIcons: Record<PageType, IconComponent> = {
  docs: FileText,
  slides: Presentation,
  data: FileSpreadsheet,
  images: FileImage,
  files: Folder,
};

interface PageList {
  pages: Page[];
  next?: string;
}

function PageCards({
  pages,
  list,
  onVersions,
  onDelete,
}: {
  pages: Page[];
  list: boolean;
  onVersions(page: Page, versions: PageVersion[]): void;
  onDelete(page: Page): void;
}) {
  const drawer = useArtifactDrawer();
  const format = useDateFormat();
  const [failed, setFailed] = useState<string | null>(null);
  const opening = useRef(0);
  const open = async (page: Page) => {
    const request = ++opening.current;
    setFailed(null);
    try {
      const { versions } = await api<{ versions: PageVersion[] }>(`/api/pages/${page.id}`);
      if (request !== opening.current) return;
      if (!versions.length) throw new Error('The page has no versions.');
      onVersions(page, versions);
      drawer.open(versions[0].artifact.id);
    } catch {
      if (request === opening.current) setFailed(page.id);
    }
  };
  return (
    <ul className={list ? 'pages-grid is-list' : 'pages-grid'}>
      {pages.map((page) => {
        const kind = attachmentKind(page.artifact.mimeType, page.artifact.name);
        return (
          <li key={page.id}>
            <div className="pages-card">
              <button type="button" className="pages-card-open" onClick={() => void open(page)}>
                {list ? (
                  <span className="pages-card-glyph" data-type={page.type} aria-hidden="true">
                    <FileGlyph
                      name={page.artifact.name}
                      mimeType={page.artifact.mimeType}
                      size={20}
                    />
                  </span>
                ) : kind === 'image' ? (
                  <span className="pages-card-image" aria-hidden="true">
                    <img src={page.artifact.url} alt="" loading="lazy" decoding="async" />
                  </span>
                ) : kind && thumbnailKinds.has(kind) ? (
                  <DataThumbnail item={page.artifact} kind={kind as ThumbnailKind} wide />
                ) : (
                  <span className="pages-card-blank" aria-hidden="true">
                    <FileGlyph
                      name={page.artifact.name}
                      mimeType={page.artifact.mimeType}
                      size={32}
                    />
                  </span>
                )}
                <span className="pages-card-details">
                  <span className="pages-card-title">{page.title}</span>
                  <span className="pages-card-meta">
                    {typeLabels[page.type]} · Version {page.version} ·{' '}
                    <time dateTime={page.createdAt}>{formatDateTime(page.createdAt, format)}</time>
                  </span>
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="pages-card-delete"
                aria-label={`Delete ${page.title}`}
                title="Delete"
                onClick={() => onDelete(page)}
              >
                <Trash2 size={15} />
              </Button>
            </div>
            {failed === page.id && <Notice>This page could not be opened. Try again.</Notice>}
          </li>
        );
      })}
    </ul>
  );
}

export function Pages() {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const [type, setType] = useState<PageType | null>(null);
  const [sort, setSort] = useState<PageSort>(
    () => pageSorts.find((item) => item === readUiPreference('nod.pages-sort')) ?? 'newest',
  );
  const [list, setList] = useState(() => readUiPreference('nod.pages-view') === 'list');
  const filter = [
    search && `q=${encodeURIComponent(search)}`,
    type && `type=${type}`,
    sort !== 'newest' && `sort=${sort}`,
  ]
    .filter(Boolean)
    .join('&');
  const { data, error, refresh } = usePageData<PageList>(`/api/pages${filter && `?${filter}`}`);
  const [more, setMore] = useState<{ filter: string; pages: Page[]; next?: string } | null>(null);
  const current = useRef(filter);
  const removed = useRef(new Set<string>());
  current.current = filter;
  const loaded = more?.filter === filter ? more : null;
  const older = loaded?.pages ?? [];
  const next = loaded ? loaded.next : data?.next;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [opened, setOpened] = useState<{ page: Page; versions: PageVersion[] } | null>(null);
  const [deleting, setDeleting] = useState<Page | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    setDeleteError('');
    try {
      await api(`/api/pages/${deleting.id}`, { method: 'DELETE' });
      removed.current.add(deleting.id);
      if (opened?.page.id === deleting.id) setOpened(null);
      setMore((value) =>
        value ? { ...value, pages: value.pages.filter((page) => page.id !== deleting.id) } : value,
      );
      setDeleting(null);
      await refresh();
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const attached = () => navigate('/');
    window.addEventListener('nod:attach-artifact', attached);
    return () => window.removeEventListener('nod:attach-artifact', attached);
  }, []);
  const files: ImagePreview[] = (opened?.versions ?? []).map(({ version, artifact }) => ({
    id: artifact.id,
    url: artifact.url,
    name: `${opened!.page.title} (version ${version})${/\.(?:data\.json|[a-z0-9]+)$/i.exec(artifact.name)?.[0] ?? ''}`,
    size: artifact.size,
    mimeType: artifact.mimeType,
  }));
  const shown = [
    ...(data?.pages ?? []),
    ...older.filter((page) => !data?.pages.some((item) => item.id === page.id)),
  ];
  const loadOlder = async () => {
    if (!next) return;
    setLoadingOlder(true);
    setOlderFailed(false);
    try {
      const result = await api<PageList>(
        `/api/pages?before=${encodeURIComponent(next)}${filter && `&${filter}`}`,
      );
      if (current.current !== filter) return;
      setMore({
        filter,
        pages: [...older, ...result.pages].filter((page) => !removed.current.has(page.id)),
        next: result.next,
      });
    } catch {
      if (current.current === filter) setOlderFailed(true);
    } finally {
      setLoadingOlder(false);
    }
  };
  return (
    <ArtifactWorkspace files={files} className="pages-workspace">
      <div className="pages-scroll">
        <div className="content-page secondary-page pages-page">
          <header className="page-heading secondary-heading">
            <PageTitle path="/pages" />
          </header>
          <div className="pages-toolbar">
            <SearchField
              className="pages-search"
              type="search"
              value={query}
              placeholder="Search"
              aria-label="Search by title"
              onChange={(event) => setQuery(event.target.value)}
            />
            <ActionMenu
              label="Sort"
              trigger={
                <Button variant="ghost" size="icon" title={`Sort: ${sortLabels[sort]}`}>
                  <Filter size={16} />
                </Button>
              }
            >
              {(close) =>
                pageSorts.map((item) => (
                  <ActionMenuItem
                    key={item}
                    checked={sort === item}
                    onClick={() => {
                      close();
                      setSort(item);
                      writeUiPreference('nod.pages-sort', item);
                    }}
                  >
                    {sortLabels[item]}
                  </ActionMenuItem>
                ))
              }
            </ActionMenu>
            <Button
              variant="ghost"
              size="icon"
              aria-label={list ? 'Show as grid' : 'Show as list'}
              title={list ? 'Show as grid' : 'Show as list'}
              onClick={() => {
                setList(!list);
                writeUiPreference('nod.pages-view', list ? 'grid' : 'list');
              }}
            >
              {list ? <LayoutGrid size={16} /> : <List size={16} />}
            </Button>
          </div>
          <div className="pages-types" role="group" aria-label="Show one type">
            {pageTypes.map((item) => {
              const Icon = typeIcons[item];
              return (
                <button
                  type="button"
                  key={item}
                  className="pages-type"
                  data-type={item}
                  aria-pressed={type === item}
                  onClick={() => setType(type === item ? null : item)}
                >
                  <span className="pages-type-tile" aria-hidden="true">
                    <Icon size={20} strokeWidth={1.75} />
                  </span>
                  {typeLabels[item]}
                </button>
              );
            })}
          </div>
          <div data-analytics-private>
            {error ? (
              <>
                <Notice>Your pages could not be loaded.</Notice>
                <Button variant="outline" onClick={() => void refresh()}>
                  Try again
                </Button>
              </>
            ) : !data ? (
              <div role="status">
                <Loading label="Loading pages" />
              </div>
            ) : !shown.length && (search || type) ? (
              <p className="pages-no-results">
                {search ? `Nothing matches “${search}”.` : `Nothing in ${typeLabels[type!]} yet.`}
              </p>
            ) : !shown.length ? (
              <section className="pages-empty" aria-labelledby="pages-empty-title">
                <span className="pages-empty-icon" aria-hidden="true">
                  <FileText size={32} />
                </span>
                <h2 id="pages-empty-title">No pages yet</h2>
                <p>
                  Every file Nod shares is kept here, with every version: pages, documents,
                  presentations, spreadsheets and images.
                </p>
              </section>
            ) : (
              <>
                <PageCards
                  pages={shown}
                  list={list}
                  onVersions={(page, versions) => setOpened({ page, versions })}
                  onDelete={(page) => {
                    setDeleteError('');
                    setDeleting(page);
                  }}
                />
                {olderFailed && <Notice>Older pages could not be loaded.</Notice>}
                {next && (
                  <Button
                    variant="outline"
                    disabled={loadingOlder}
                    onClick={() => void loadOlder()}
                  >
                    Show older pages
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null);
        }}
      >
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Delete {deleting?.title}?</DialogTitle>
          <p className="field-hint">
            Every version is deleted and the page is removed from the chat it was made in. This
            cannot be undone.
          </p>
          {deleteError && <Notice>{deleteError}</Notice>}
          <div className="dialog-actions">
            <Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </ArtifactWorkspace>
  );
}

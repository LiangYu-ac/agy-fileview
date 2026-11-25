import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { z } from 'zod/v4';
import { Lang, t } from './i18n';
import { getEntryIcon, ICONS } from './icons';

interface FsEntry {
  name: string;
  path: string;
  relativePath: string;
  fileUri: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtimeMs: number;
  ext: string;
  isHidden: boolean;
}

interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  isActive: boolean;
}

interface ShortcutInfo {
  label: string;
  path: string;
}

interface Prefs {
  lastPath: string;
  pinnedFolders: string[];
  showHidden: boolean;
  sortBy: 'name' | 'mtime' | 'size';
  sortDir: 'asc' | 'desc';
  lang: Lang;
}

interface ClipboardState {
  mode: 'copy' | 'cut';
  entries: FsEntry[];
}

interface ContextMenuItem {
  label: string;
  icon?: string;
  shortcut?: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

type ContextMenuSpec = ContextMenuItem | { separator: true };

const ToggleAuxPaneResultSchema = z.object({
  isError: z.boolean().optional(),
}).passthrough();

const app = new App({ name: 'FileView', version: '1.0.0' }, {});

const state = {
  platform: 'win32',
  rootPath: '',
  parentPath: null as string | null,
  projects: [] as ProjectInfo[],
  shortcuts: [] as ShortcutInfo[],
  drives: [] as ShortcutInfo[],
  prefs: {
    lastPath: '',
    pinnedFolders: [],
    showHidden: false,
    sortBy: 'name',
    sortDir: 'asc',
    lang: 'zh',
  } as Prefs,
  childrenMap: new Map<string, FsEntry[]>(),
  expanded: new Set<string>(),
  loadingDirs: new Set<string>(),
  selectedPath: null as string | null,
  entryIndex: new Map<string, FsEntry>(),
  visiblePaths: [] as string[],
  searchQuery: '',
  deepSearch: false,
  searchResults: null as FsEntry[] | null,
  clipboard: null as ClipboardState | null,
  initializedFromHost: false,
  canUpdateModelContext: false,
};

// Limit concurrent server calls well under Antigravity's 4-call cap
let activeCalls = 0;
const callQueue: Array<() => void> = [];

async function callTool<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  if (activeCalls >= 2) {
    await new Promise<void>((resolve) => callQueue.push(resolve));
  }
  activeCalls += 1;
  try {
    const result = await app.callServerTool({ name, arguments: args });
    if (result.isError) {
      const msg =
        (result.structuredContent as { error?: string } | undefined)?.error ||
        (result.content?.find((c) => c.type === 'text') as { text?: string } | undefined)?.text ||
        'Operation failed';
      throw new Error(msg);
    }
    return (result.structuredContent || {}) as T;
  } finally {
    activeCalls -= 1;
    const next = callQueue.shift();
    if (next) next();
  }
}

// DOM refs
const elLocationSelect = document.getElementById('location-select') as HTMLSelectElement;
const elBreadcrumbs = document.getElementById('breadcrumbs') as HTMLDivElement;
const elTreeContainer = document.getElementById('tree-container') as HTMLElement;
const elSearchInput = document.getElementById('search-input') as HTMLInputElement;
const elSearchClear = document.getElementById('btn-search-clear') as HTMLButtonElement;
const elSearchMode = document.getElementById('btn-search-mode') as HTMLButtonElement;
const elClipboardBanner = document.getElementById('clipboard-banner') as HTMLDivElement;
const elClipboardText = document.getElementById('clipboard-text') as HTMLSpanElement;
const elBannerPaste = document.getElementById('btn-banner-paste') as HTMLButtonElement;
const elBannerClear = document.getElementById('btn-banner-clear') as HTMLButtonElement;
const elStatusLeft = document.getElementById('status-left') as HTMLSpanElement;
const elStatusRight = document.getElementById('status-right') as HTMLSpanElement;
const elContextMenu = document.getElementById('context-menu') as HTMLDivElement;
const elModalBackdrop = document.getElementById('modal-backdrop') as HTMLDivElement;
const elModalCard = document.getElementById('modal-card') as HTMLDivElement;
const elToast = document.getElementById('toast') as HTMLDivElement;

const btnNewFile = document.getElementById('btn-new-file') as HTMLButtonElement;
const btnNewFolder = document.getElementById('btn-new-folder') as HTMLButtonElement;
const btnRevealRoot = document.getElementById('btn-reveal-root') as HTMLButtonElement;
const btnTerminalRoot = document.getElementById('btn-terminal-root') as HTMLButtonElement;
const btnToggleHidden = document.getElementById('btn-toggle-hidden') as HTMLButtonElement;
const btnSort = document.getElementById('btn-sort') as HTMLButtonElement;
const btnLang = document.getElementById('btn-lang') as HTMLButtonElement;
const btnRefresh = document.getElementById('btn-refresh') as HTMLButtonElement;
const btnUp = document.getElementById('btn-up') as HTMLButtonElement;
const btnCopyCwd = document.getElementById('btn-copy-cwd') as HTMLButtonElement;
const btnJumpPath = document.getElementById('btn-jump-path') as HTMLButtonElement;
const searchIconSlot = document.getElementById('search-icon-slot') as HTMLSpanElement;

let toastTimer: number | null = null;
function showToast(message: string, isError = false) {
  elToast.textContent = message;
  elToast.classList.toggle('error', isError);
  elToast.classList.remove('hidden');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    elToast.classList.add('hidden');
  }, 2600);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes / 1024;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val >= 10 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

function formatDate(ms: number): string {
  if (!ms) return '-';
  try {
    return new Date(ms).toLocaleString(state.prefs.lang === 'zh' ? 'zh-CN' : 'en-US');
  } catch {
    return String(ms);
  }
}

function getBaseName(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) || p : cleaned || p;
}

function getParentPath(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  if (/^[a-zA-Z]:$/.test(cleaned)) return `${cleaned}\\`;
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  if (idx < 0) return p;
  if (idx === 0) return '/';
  const parent = cleaned.slice(0, idx);
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}\\` : parent;
}

function isPinned(folderPath: string): boolean {
  const norm = state.platform === 'win32' ? folderPath.toLowerCase() : folderPath;
  return state.prefs.pinnedFolders.some(
    (p) => (state.platform === 'win32' ? p.toLowerCase() : p) === norm
  );
}

async function copyText(text: string, label: string) {
  const i18n = t(state.prefs.lang);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      showToast(i18n.toastCopied(label));
      return;
    }
  } catch {
    // fallback below
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) {
      showToast(i18n.toastCopied(label));
      return;
    }
  } catch {
    // fallback below
  }
  try {
    await callTool('fv_copy_clipboard', { text });
    showToast(i18n.toastCopied(label));
  } catch (err) {
    showToast((err as Error).message, true);
  }
}

function applyToolbarChrome() {
  const i18n = t(state.prefs.lang);
  btnNewFile.innerHTML = ICONS.newFile;
  btnNewFile.title = i18n.newFile;
  btnNewFolder.innerHTML = ICONS.newFolder;
  btnNewFolder.title = i18n.newFolder;
  btnRevealRoot.innerHTML = ICONS.reveal;
  btnRevealRoot.title = i18n.revealCurrent;
  btnTerminalRoot.innerHTML = ICONS.terminal;
  btnTerminalRoot.title = i18n.openTerminalCurrent;
  btnToggleHidden.innerHTML = ICONS.eye;
  btnToggleHidden.title = i18n.toggleHidden;
  btnToggleHidden.classList.toggle('active', state.prefs.showHidden);
  btnSort.innerHTML = ICONS.sort;
  btnSort.title = i18n.sortLabel(state.prefs.sortBy, state.prefs.sortDir);
  btnLang.textContent = state.prefs.lang === 'zh' ? '中' : 'EN';
  btnLang.title = state.prefs.lang === 'zh' ? 'Switch to English' : '切换为中文';
  btnRefresh.innerHTML = ICONS.refresh;
  btnRefresh.title = i18n.refresh;

  btnUp.innerHTML = ICONS.up;
  btnUp.title = i18n.upLevel;
  btnUp.disabled = !state.parentPath;
  btnCopyCwd.innerHTML = ICONS.copy;
  btnCopyCwd.title = i18n.copyCurrentPath;
  btnJumpPath.innerHTML = ICONS.jump;
  btnJumpPath.title = i18n.jumpPath;

  searchIconSlot.innerHTML = ICONS.search;
  elSearchInput.placeholder = state.deepSearch
    ? i18n.searchDeepPlaceholder
    : i18n.searchFilterPlaceholder;
  elSearchMode.textContent = state.deepSearch ? i18n.searchDeepBtn : i18n.searchLocalBtn;
  elSearchMode.classList.toggle('active', state.deepSearch);
  elBannerPaste.textContent = i18n.pasteHere;
  elBannerClear.textContent = i18n.cancel;
}

function renderLocationSelect() {
  const i18n = t(state.prefs.lang);
  elLocationSelect.innerHTML = '';

  const addGroup = (label: string, items: Array<{ label: string; value: string }>) => {
    if (items.length === 0) return;
    const grp = document.createElement('optgroup');
    grp.label = label;
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      grp.appendChild(opt);
    }
    elLocationSelect.appendChild(grp);
  };

  const known = new Set<string>();
  const addKnown = (p: string) => known.add(state.platform === 'win32' ? p.toLowerCase() : p);
  const hasKnown = (p: string) => known.has(state.platform === 'win32' ? p.toLowerCase() : p);

  if (state.rootPath && !state.projects.some((p) => (state.platform === 'win32' ? p.path.toLowerCase() : p.path) === (state.platform === 'win32' ? state.rootPath.toLowerCase() : state.rootPath))) {
    const currentOpt = document.createElement('option');
    currentOpt.value = state.rootPath;
    currentOpt.textContent = `📁 ${getBaseName(state.rootPath)} (${state.rootPath})`;
    elLocationSelect.appendChild(currentOpt);
    addKnown(state.rootPath);
  }

  addGroup(
    i18n.projectsGroup,
    state.projects.map((p) => {
      addKnown(p.path);
      return {
        label: p.isActive ? `★ ${p.name}` : p.name,
        value: p.path,
      };
    })
  );

  addGroup(
    i18n.pinnedGroup,
    state.prefs.pinnedFolders
      .filter((p) => !hasKnown(p))
      .map((p) => {
        addKnown(p);
        return { label: `📌 ${getBaseName(p)}`, value: p };
      })
  );

  addGroup(
    i18n.shortcutsGroup,
    state.shortcuts
      .filter((s) => !hasKnown(s.path))
      .map((s) => {
        addKnown(s.path);
        return { label: s.label, value: s.path };
      })
  );

  addGroup(
    i18n.drivesGroup,
    state.drives
      .filter((d) => !hasKnown(d.path))
      .map((d) => {
        addKnown(d.path);
        return { label: d.label, value: d.path };
      })
  );

  const jumpOpt = document.createElement('option');
  jumpOpt.value = '__JUMP__';
  jumpOpt.textContent = i18n.jumpOption;
  elLocationSelect.appendChild(jumpOpt);

  elLocationSelect.value = state.rootPath;
}

function renderBreadcrumbs() {
  elBreadcrumbs.innerHTML = '';
  if (!state.rootPath) return;

  const segments: Array<{ label: string; path: string }> = [];
  if (state.platform === 'win32') {
    const cleaned = state.rootPath.replace(/\\+$/, '');
    const parts = cleaned.split('\\').filter(Boolean);
    let acc = '';
    parts.forEach((part, idx) => {
      if (idx === 0 && /^[a-zA-Z]:$/.test(part)) {
        acc = `${part}\\`;
      } else {
        acc = acc.endsWith('\\') ? `${acc}${part}` : `${acc}\\${part}`;
      }
      segments.push({ label: part, path: acc });
    });
  } else {
    const parts = state.rootPath.split('/').filter(Boolean);
    segments.push({ label: '/', path: '/' });
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      segments.push({ label: part, path: acc });
    }
  }

  segments.forEach((seg, idx) => {
    if (idx > 0) {
      const sep = document.createElement('span');
      sep.className = 'fv-crumb-sep';
      sep.textContent = '/';
      elBreadcrumbs.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `fv-crumb ${idx === segments.length - 1 ? 'current' : ''}`;
    btn.textContent = seg.label;
    btn.title = seg.path;
    btn.addEventListener('click', () => {
      if (seg.path !== state.rootPath) {
        void navigateTo(seg.path);
      }
    });
    elBreadcrumbs.appendChild(btn);
  });

  elBreadcrumbs.scrollLeft = elBreadcrumbs.scrollWidth;
}

function renderClipboardBanner() {
  const i18n = t(state.prefs.lang);
  if (!state.clipboard || state.clipboard.entries.length === 0) {
    elClipboardBanner.classList.add('hidden');
    return;
  }
  const names = state.clipboard.entries.map((e) => e.name).join(', ');
  elClipboardText.textContent =
    state.clipboard.mode === 'copy'
      ? i18n.clipboardCopy(names)
      : i18n.clipboardCut(names);
  elClipboardBanner.classList.remove('hidden');
}

function isCutEntry(entryPath: string): boolean {
  if (!state.clipboard || state.clipboard.mode !== 'cut') return false;
  return state.clipboard.entries.some((e) => e.path === entryPath);
}

function createTreeRow(entry: FsEntry, depth: number, isSearchMode: boolean): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'fv-row';
  row.dataset.path = entry.path;
  row.setAttribute('role', 'treeitem');
  if (state.selectedPath === entry.path) row.classList.add('selected');
  if (isCutEntry(entry.path)) row.classList.add('cut');
  row.style.paddingLeft = `${8 + depth * 16}px`;

  if (!isSearchMode) {
    const chev = document.createElement('span');
    const expanded = state.expanded.has(entry.path);
    chev.className = `fv-chevron ${entry.isDirectory ? (expanded ? 'expanded' : '') : 'placeholder'}`;
    chev.innerHTML = ICONS.chevron;
    if (entry.isDirectory) {
      chev.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void toggleFolder(entry.path);
      });
    }
    row.appendChild(chev);
  }

  const icon = document.createElement('span');
  icon.className = 'fv-file-icon';
  icon.innerHTML = getEntryIcon(
    entry.isDirectory,
    !isSearchMode && state.expanded.has(entry.path),
    entry.ext
  );
  row.appendChild(icon);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'fv-row-name';
  nameSpan.textContent = entry.name;
  nameSpan.title = entry.path;
  row.appendChild(nameSpan);

  if (isSearchMode && entry.relativePath !== entry.name) {
    const relSpan = document.createElement('span');
    relSpan.className = 'fv-row-rel';
    relSpan.textContent = entry.relativePath;
    relSpan.title = entry.relativePath;
    row.appendChild(relSpan);
  } else if (!entry.isDirectory) {
    const metaSpan = document.createElement('span');
    metaSpan.className = 'fv-row-meta';
    metaSpan.textContent = formatBytes(entry.size);
    row.appendChild(metaSpan);
  }

  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'fv-row-more';
  moreBtn.innerHTML = ICONS.more;
  moreBtn.title = t(state.prefs.lang).statusHint;
  moreBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    selectPath(entry.path);
    const rect = moreBtn.getBoundingClientRect();
    openEntryContextMenu(entry, rect.left, rect.bottom + 2);
  });
  row.appendChild(moreBtn);

  row.addEventListener('click', () => {
    closeContextMenu();
    selectPath(entry.path);
    if (isSearchMode) return;
    if (entry.isDirectory) {
      void toggleFolder(entry.path);
    }
  });

  row.addEventListener('dblclick', () => {
    if (entry.isDirectory) {
      void navigateTo(entry.path);
    } else {
      void openInSidePaneOrPreview(entry);
    }
  });

  row.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    selectPath(entry.path);
    openEntryContextMenu(entry, ev.clientX, ev.clientY);
  });

  return row;
}

function renderTree() {
  const i18n = t(state.prefs.lang);
  elTreeContainer.innerHTML = '';
  state.entryIndex.clear();
  state.visiblePaths = [];

  const frag = document.createDocumentFragment();
  const query = state.searchQuery.trim().toLowerCase();

  if (state.deepSearch && query && state.searchResults !== null) {
    if (state.searchResults.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'fv-empty-state';
      empty.textContent = i18n.emptySearch;
      elTreeContainer.appendChild(empty);
      elStatusLeft.textContent = i18n.statusItems(0);
      return;
    }
    for (const entry of state.searchResults) {
      state.entryIndex.set(entry.path, entry);
      state.visiblePaths.push(entry.path);
      frag.appendChild(createTreeRow(entry, 0, true));
    }
    elTreeContainer.appendChild(frag);
    elStatusLeft.textContent = i18n.statusItems(state.searchResults.length);
    return;
  }

  let totalRendered = 0;
  const appendChildren = (dirPath: string, depth: number) => {
    const entries = state.childrenMap.get(dirPath) || [];
    for (const entry of entries) {
      const matchesFilter = !query || entry.name.toLowerCase().includes(query);
      const isExpanded = state.expanded.has(entry.path);
      if (matchesFilter || (entry.isDirectory && isExpanded)) {
        state.entryIndex.set(entry.path, entry);
        state.visiblePaths.push(entry.path);
        frag.appendChild(createTreeRow(entry, depth, false));
        totalRendered += 1;
      }
      if (entry.isDirectory && isExpanded) {
        if (state.loadingDirs.has(entry.path)) {
          const loadingRow = document.createElement('div');
          loadingRow.className = 'fv-row';
          loadingRow.style.paddingLeft = `${28 + depth * 16}px`;
          loadingRow.innerHTML = `<span class="fv-row-meta">${escapeHtml(i18n.loading)}</span>`;
          frag.appendChild(loadingRow);
        } else {
          appendChildren(entry.path, depth + 1);
        }
      }
    }
  };

  if (state.rootPath) {
    appendChildren(state.rootPath, 0);
  }

  if (totalRendered === 0) {
    const empty = document.createElement('div');
    empty.className = 'fv-empty-state';
    empty.textContent = query ? i18n.emptySearch : i18n.emptyFolder;
    elTreeContainer.appendChild(empty);
  } else {
    elTreeContainer.appendChild(frag);
  }

  elStatusLeft.textContent = i18n.statusItems(totalRendered);
  elStatusRight.textContent = i18n.statusHint;
}

function selectPath(targetPath: string | null) {
  state.selectedPath = targetPath;
  const rows = elTreeContainer.querySelectorAll('.fv-row');
  rows.forEach((r) => {
    const el = r as HTMLElement;
    el.classList.toggle('selected', Boolean(targetPath && el.dataset.path === targetPath));
  });
}

async function loadDir(dirPath: string) {
  state.loadingDirs.add(dirPath);
  try {
    const res = await callTool<{
      path: string;
      parentPath: string | null;
      entries: FsEntry[];
    }>('fv_list_dir', {
      path: dirPath,
      rootPath: state.rootPath || dirPath,
      showHidden: state.prefs.showHidden,
      sortBy: state.prefs.sortBy,
      sortDir: state.prefs.sortDir,
    });
    state.childrenMap.set(res.path, res.entries || []);
    if (res.path === state.rootPath) {
      state.parentPath = res.parentPath;
    }
  } finally {
    state.loadingDirs.delete(dirPath);
  }
}

async function navigateTo(targetPath: string) {
  closeContextMenu();
  try {
    const res = await callTool<{
      path: string;
      parentPath: string | null;
      entries: FsEntry[];
    }>('fv_list_dir', {
      path: targetPath,
      rootPath: targetPath,
      showHidden: state.prefs.showHidden,
      sortBy: state.prefs.sortBy,
      sortDir: state.prefs.sortDir,
    });
    state.rootPath = res.path;
    state.parentPath = res.parentPath;
    state.childrenMap.clear();
    state.expanded.clear();
    state.childrenMap.set(res.path, res.entries || []);
    state.selectedPath = null;
    state.searchResults = null;
    state.prefs.lastPath = res.path;

    applyToolbarChrome();
    renderLocationSelect();
    renderBreadcrumbs();
    renderTree();

    void callTool('fv_save_prefs', { lastPath: res.path }).catch(() => {});
  } catch (err) {
    showToast((err as Error).message, true);
    renderLocationSelect();
  }
}

async function toggleFolder(folderPath: string) {
  if (state.expanded.has(folderPath)) {
    state.expanded.delete(folderPath);
    renderTree();
    return;
  }
  state.expanded.add(folderPath);
  if (!state.childrenMap.has(folderPath)) {
    renderTree();
    try {
      await loadDir(folderPath);
    } catch (err) {
      state.expanded.delete(folderPath);
      showToast((err as Error).message, true);
    }
  }
  renderTree();
}

async function refreshAll() {
  if (!state.rootPath) return;
  try {
    const dirsToReload = [state.rootPath, ...Array.from(state.expanded)];
    for (const d of dirsToReload) {
      try {
        await loadDir(d);
      } catch {
        if (d !== state.rootPath) state.expanded.delete(d);
      }
    }
    if (state.deepSearch && state.searchQuery.trim()) {
      await runDeepSearch();
    } else {
      renderBreadcrumbs();
      renderTree();
    }
  } catch (err) {
    showToast((err as Error).message, true);
  }
}

async function runDeepSearch() {
  const query = elSearchInput.value.trim();
  if (!query || !state.rootPath) {
    state.searchResults = null;
    renderTree();
    return;
  }
  try {
    const res = await callTool<{ results: FsEntry[] }>('fv_search_files', {
      rootPath: state.rootPath,
      query,
      showHidden: state.prefs.showHidden,
      maxResults: 150,
    });
    state.searchResults = res.results || [];
    renderTree();
  } catch (err) {
    showToast((err as Error).message, true);
  }
}

async function openInSidePaneOrPreview(entry: FsEntry) {
  try {
    const res = await app.request(
      {
        method: 'com.google.antigravity/toggle-aux-pane',
        params: { tabType: 'fileView', uri: entry.fileUri },
      },
      ToggleAuxPaneResultSchema
    );
    if (!res?.isError) return;
  } catch {
    // Fallback to quick preview when host doesn't support toggle-aux-pane (e.g. global view)
  }
  await openFallbackPreview(entry);
}

async function openFallbackPreview(entry: FsEntry) {
  const i18n = t(state.prefs.lang);
  try {
    const data = await callTool<{
      name: string;
      path: string;
      size: number;
      truncated: boolean;
      isBinary: boolean;
      text: string;
    }>('fv_read_preview', { path: entry.path });

    openModal({
      title: `${data.name} (${formatBytes(data.size)})`,
      wide: true,
      bodyHtml: data.isBinary
        ? `<p>${escapeHtml(i18n.previewBinary)}</p><div class="fv-path-box">${escapeHtml(data.path)}</div>`
        : `${data.truncated ? `<p style="margin:0 0 8px;color:var(--fv-text-3);font-size:12px;">${escapeHtml(i18n.previewTruncated)}</p>` : ''}<pre class="fv-preview-pre">${escapeHtml(data.text)}</pre>`,
      buttons: [
        {
          label: i18n.openWithDefault,
          onClick: async () => {
            await callTool('fv_open_default', { path: entry.path });
            closeModal();
          },
        },
        { label: i18n.close, primary: true, onClick: closeModal },
      ],
    });
  } catch (err) {
    showToast((err as Error).message, true);
  }
}

// Modals
function closeModal() {
  elModalBackdrop.classList.add('hidden');
  elModalCard.innerHTML = '';
  elModalCard.classList.remove('wide');
}

function openModal(opts: {
  title: string;
  bodyHtml: string;
  wide?: boolean;
  buttons: Array<{ label: string; primary?: boolean; danger?: boolean; onClick: () => void | Promise<void> }>;
  onMount?: (card: HTMLElement) => void;
}) {
  closeContextMenu();
  elModalCard.classList.toggle('wide', Boolean(opts.wide));
  elModalCard.innerHTML = `
    <div class="fv-modal-header">
      <span>${escapeHtml(opts.title)}</span>
      <button type="button" class="fv-icon-btn fv-icon-btn-sm" id="modal-close-x">×</button>
    </div>
    <div class="fv-modal-body">${opts.bodyHtml}</div>
    <div class="fv-modal-footer" id="modal-footer"></div>
  `;

  const footer = elModalCard.querySelector('#modal-footer') as HTMLElement;
  elModalCard.querySelector('#modal-close-x')?.addEventListener('click', closeModal);

  for (const btnSpec of opts.buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `fv-btn ${btnSpec.primary ? 'fv-btn-primary' : ''} ${btnSpec.danger ? 'fv-btn-danger' : ''}`;
    btn.textContent = btnSpec.label;
    btn.addEventListener('click', () => {
      void btnSpec.onClick();
    });
    footer.appendChild(btn);
  }

  elModalBackdrop.classList.remove('hidden');
  opts.onMount?.(elModalCard);
}

function promptCreateItem(parentDir: string, type: 'file' | 'folder') {
  const i18n = t(state.prefs.lang);
  openModal({
    title: type === 'folder' ? i18n.createFolderTitle : i18n.createFileTitle,
    bodyHtml: `
      <label style="display:block;margin-bottom:6px;font-weight:500;">${escapeHtml(i18n.nameLabel)}</label>
      <input id="modal-name-input" class="fv-input" type="text" placeholder="${escapeHtml(type === 'folder' ? i18n.namePlaceholderFolder : i18n.namePlaceholderFile)}" />
      <div class="fv-path-box">${escapeHtml(parentDir)}</div>
    `,
    buttons: [
      { label: i18n.cancel, onClick: closeModal },
      {
        label: i18n.confirm,
        primary: true,
        onClick: async () => {
          const input = document.getElementById('modal-name-input') as HTMLInputElement;
          const name = input.value.trim();
          if (!name) return;
          try {
            const res = await callTool<{ entry: FsEntry }>('fv_create_item', {
              parentPath: parentDir,
              name,
              type,
              rootPath: state.rootPath,
            });
            closeModal();
            if (parentDir !== state.rootPath) state.expanded.add(parentDir);
            state.selectedPath = res.entry.path;
            await refreshAll();
            showToast(i18n.toastCreated(res.entry.name));
          } catch (err) {
            showToast((err as Error).message, true);
          }
        },
      },
    ],
    onMount: () => {
      const input = document.getElementById('modal-name-input') as HTMLInputElement;
      input.focus();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          (elModalCard.querySelector('.fv-btn-primary') as HTMLButtonElement | null)?.click();
        }
      });
    },
  });
}

function promptRenameItem(entry: FsEntry) {
  const i18n = t(state.prefs.lang);
  openModal({
    title: i18n.renameTitle,
    bodyHtml: `
      <label style="display:block;margin-bottom:6px;font-weight:500;">${escapeHtml(i18n.nameLabel)}</label>
      <input id="modal-rename-input" class="fv-input" type="text" value="${escapeHtml(entry.name)}" />
    `,
    buttons: [
      { label: i18n.cancel, onClick: closeModal },
      {
        label: i18n.confirm,
        primary: true,
        onClick: async () => {
          const input = document.getElementById('modal-rename-input') as HTMLInputElement;
          const newName = input.value.trim();
          if (!newName || newName === entry.name) {
            closeModal();
            return;
          }
          try {
            const res = await callTool<{ entry: FsEntry }>('fv_rename_item', {
              path: entry.path,
              newName,
              rootPath: state.rootPath,
            });
            closeModal();
            if (state.expanded.has(entry.path)) {
              state.expanded.delete(entry.path);
              state.expanded.add(res.entry.path);
            }
            state.selectedPath = res.entry.path;
            await refreshAll();
            showToast(i18n.toastRenamed(res.entry.name));
          } catch (err) {
            showToast((err as Error).message, true);
          }
        },
      },
    ],
    onMount: () => {
      const input = document.getElementById('modal-rename-input') as HTMLInputElement;
      input.focus();
      const dotIdx = entry.isDirectory ? -1 : entry.name.lastIndexOf('.');
      if (dotIdx > 0) {
        input.setSelectionRange(0, dotIdx);
      } else {
        input.select();
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          (elModalCard.querySelector('.fv-btn-primary') as HTMLButtonElement | null)?.click();
        }
      });
    },
  });
}

function promptJumpPath() {
  const i18n = t(state.prefs.lang);
  openModal({
    title: i18n.jumpTitle,
    bodyHtml: `
      <input id="modal-jump-input" class="fv-input fv-mono" type="text" value="${escapeHtml(state.rootPath)}" placeholder="${escapeHtml(i18n.jumpPlaceholder)}" />
    `,
    buttons: [
      { label: i18n.cancel, onClick: closeModal },
      {
        label: i18n.confirm,
        primary: true,
        onClick: async () => {
          const input = document.getElementById('modal-jump-input') as HTMLInputElement;
          const target = input.value.trim();
          if (!target) return;
          closeModal();
          await navigateTo(target);
        },
      },
    ],
    onMount: () => {
      const input = document.getElementById('modal-jump-input') as HTMLInputElement;
      input.focus();
      input.select();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          (elModalCard.querySelector('.fv-btn-primary') as HTMLButtonElement | null)?.click();
        }
      });
    },
  });
}

function promptDeleteItem(entry: FsEntry) {
  const i18n = t(state.prefs.lang);
  openModal({
    title: i18n.deleteTitle,
    bodyHtml: `
      <p style="margin:0;">${escapeHtml(i18n.deleteConfirmDesc(entry.name))}</p>
      <div class="fv-path-box">${escapeHtml(entry.path)}</div>
      <label class="fv-checkbox-row">
        <input id="modal-perm-delete" type="checkbox" />
        <span>${escapeHtml(i18n.permanentDeleteCheck)}</span>
      </label>
    `,
    buttons: [
      { label: i18n.cancel, onClick: closeModal },
      {
        label: i18n.deleteBtnTrash,
        danger: true,
        onClick: async () => {
          const permCheck = document.getElementById('modal-perm-delete') as HTMLInputElement;
          const permanent = Boolean(permCheck?.checked);
          try {
            await callTool('fv_delete_item', {
              paths: [entry.path],
              permanent,
            });
            closeModal();
            if (state.selectedPath === entry.path) state.selectedPath = null;
            state.expanded.delete(entry.path);
            await refreshAll();
            showToast(permanent ? i18n.toastDeletedPermanent : i18n.toastTrashed);
          } catch (err) {
            showToast((err as Error).message, true);
          }
        },
      },
    ],
    onMount: () => {
      const permCheck = document.getElementById('modal-perm-delete') as HTMLInputElement;
      const dangerBtn = elModalCard.querySelector('.fv-btn-danger') as HTMLButtonElement;
      permCheck?.addEventListener('change', () => {
        dangerBtn.textContent = permCheck.checked ? i18n.deleteBtnPermanent : i18n.deleteBtnTrash;
      });
    },
  });
}

async function openPropertiesModal(entry: FsEntry) {
  const i18n = t(state.prefs.lang);
  try {
    const props = await callTool<{
      name: string;
      path: string;
      isDirectory: boolean;
      size: number;
      folderStats?: { files: number; folders: number; totalSize: number; truncated: boolean } | null;
      birthtimeMs: number;
      mtimeMs: number;
      readonly: boolean;
      sha256: string | null;
      hashError: string | null;
    }>('fv_get_properties', { path: entry.path, computeHash: false });

    const containsRow = props.folderStats
      ? `<tr><th>${escapeHtml(i18n.propContains)}</th><td>${props.folderStats.files} files, ${props.folderStats.folders} folders${props.folderStats.truncated ? '+' : ''}</td></tr>`
      : '';

    const hashRow = !props.isDirectory
      ? `<tr><th>${escapeHtml(i18n.propHash)}</th><td id="prop-hash-cell"><button id="btn-calc-hash" class="fv-mini-btn" type="button">${escapeHtml(i18n.computeHashBtn)}</button></td></tr>`
      : '';

    openModal({
      title: `${i18n.propsTitle} - ${props.name}`,
      bodyHtml: `
        <table class="fv-prop-table">
          <tr><th>${escapeHtml(i18n.propName)}</th><td>${escapeHtml(props.name)}</td></tr>
          <tr><th>${escapeHtml(i18n.propType)}</th><td>${escapeHtml(props.isDirectory ? i18n.propTypeFolder : i18n.propTypeFile)}</td></tr>
          <tr><th>${escapeHtml(i18n.propPath)}</th><td class="fv-mono">${escapeHtml(props.path)}</td></tr>
          <tr><th>${escapeHtml(i18n.propSize)}</th><td>${escapeHtml(formatBytes(props.size))} (${props.size.toLocaleString()} B)</td></tr>
          ${containsRow}
          <tr><th>${escapeHtml(i18n.propCreated)}</th><td>${escapeHtml(formatDate(props.birthtimeMs))}</td></tr>
          <tr><th>${escapeHtml(i18n.propModified)}</th><td>${escapeHtml(formatDate(props.mtimeMs))}</td></tr>
          <tr><th>${escapeHtml(i18n.propPerm)}</th><td>${escapeHtml(props.readonly ? i18n.propReadonlyYes : i18n.propReadonlyNo)}</td></tr>
          ${hashRow}
        </table>
      `,
      buttons: [
        {
          label: i18n.copyFullPath,
          onClick: () => copyText(props.path, i18n.copyFullPath),
        },
        {
          label: i18n.revealInExplorer,
          primary: true,
          onClick: async () => {
            await callTool('fv_reveal_in_explorer', { path: props.path });
          },
        },
        { label: i18n.close, onClick: closeModal },
      ],
      onMount: () => {
        const hashBtn = document.getElementById('btn-calc-hash') as HTMLButtonElement | null;
        const hashCell = document.getElementById('prop-hash-cell') as HTMLElement | null;
        hashBtn?.addEventListener('click', async () => {
          if (!hashCell) return;
          hashBtn.disabled = true;
          hashBtn.textContent = i18n.computing;
          try {
            const withHash = await callTool<{ sha256: string | null; hashError: string | null }>(
              'fv_get_properties',
              { path: props.path, computeHash: true }
            );
            hashCell.innerHTML = `<span class="fv-mono">${escapeHtml(withHash.sha256 || withHash.hashError || '-')}</span>`;
          } catch (err) {
            hashCell.textContent = (err as Error).message;
          }
        });
      },
    });
  } catch (err) {
    showToast((err as Error).message, true);
  }
}

// Actions
async function performPaste(targetDir: string) {
  const i18n = t(state.prefs.lang);
  if (!state.clipboard || state.clipboard.entries.length === 0) return;
  try {
    const res = await callTool<{ entries: FsEntry[] }>('fv_copy_or_move', {
      sources: state.clipboard.entries.map((e) => e.path),
      targetDir,
      mode: state.clipboard.mode,
      rootPath: state.rootPath,
    });
    if (state.clipboard.mode === 'cut') {
      state.clipboard = null;
      renderClipboardBanner();
    }
    if (targetDir !== state.rootPath) state.expanded.add(targetDir);
    if (res.entries?.[0]?.path) state.selectedPath = res.entries[0].path;
    await refreshAll();
    showToast(i18n.toastPasted(res.entries?.length || 1));
  } catch (err) {
    showToast((err as Error).message, true);
  }
}

async function performDuplicate(entry: FsEntry) {
  const i18n = t(state.prefs.lang);
  try {
    const res = await callTool<{ entry: FsEntry }>('fv_duplicate_item', {
      path: entry.path,
      rootPath: state.rootPath,
    });
    state.selectedPath = res.entry.path;
    await refreshAll();
    showToast(i18n.toastDuplicated(res.entry.name));
  } catch (err) {
    showToast((err as Error).message, true);
  }
}

async function togglePinFolder(folderPath: string) {
  const i18n = t(state.prefs.lang);
  const norm = state.platform === 'win32' ? folderPath.toLowerCase() : folderPath;
  const currentlyPinned = isPinned(folderPath);
  const nextPinned = currentlyPinned
    ? state.prefs.pinnedFolders.filter(
        (p) => (state.platform === 'win32' ? p.toLowerCase() : p) !== norm
      )
    : [...state.prefs.pinnedFolders, folderPath];

  state.prefs.pinnedFolders = nextPinned;
  renderLocationSelect();
  try {
    await callTool('fv_save_prefs', { pinnedFolders: nextPinned });
    showToast(currentlyPinned ? i18n.toastUnpinned : i18n.toastPinned);
  } catch (err) {
    showToast((err as Error).message, true);
  }
}

// Context menu
function closeContextMenu() {
  elContextMenu.classList.add('hidden');
  elContextMenu.innerHTML = '';
}

function showContextMenu(items: ContextMenuSpec[], clientX: number, clientY: number) {
  elContextMenu.innerHTML = '';
  for (const item of items) {
    if ('separator' in item) {
      const sep = document.createElement('div');
      sep.className = 'fv-menu-sep';
      elContextMenu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `fv-menu-item ${item.primary ? 'primary' : ''} ${item.danger ? 'danger' : ''}`;
    btn.disabled = Boolean(item.disabled);
    btn.innerHTML = `
      <span class="fv-menu-icon">${item.icon || ''}</span>
      <span class="fv-menu-label">${escapeHtml(item.label)}</span>
      ${item.shortcut ? `<span class="fv-menu-shortcut">${escapeHtml(item.shortcut)}</span>` : ''}
    `;
    btn.addEventListener('click', () => {
      closeContextMenu();
      item.onClick();
    });
    elContextMenu.appendChild(btn);
  }

  elContextMenu.classList.remove('hidden');
  elContextMenu.style.left = '0px';
  elContextMenu.style.top = '0px';

  const rect = elContextMenu.getBoundingClientRect();
  const maxX = Math.max(8, window.innerWidth - rect.width - 8);
  const maxY = Math.max(8, window.innerHeight - rect.height - 8);
  elContextMenu.style.left = `${Math.min(Math.max(8, clientX), maxX)}px`;
  elContextMenu.style.top = `${Math.min(Math.max(8, clientY), maxY)}px`;
}

function openEntryContextMenu(entry: FsEntry, x: number, y: number) {
  const i18n = t(state.prefs.lang);
  const hasClipboard = Boolean(state.clipboard && state.clipboard.entries.length > 0);

  if (entry.isDirectory) {
    const expanded = state.expanded.has(entry.path);
    const items: ContextMenuSpec[] = [
      {
        label: expanded ? i18n.collapseFolder : i18n.expandFolder,
        icon: ICONS.chevron,
        onClick: () => { void toggleFolder(entry.path); },
      },
      {
        label: i18n.enterFolder,
        icon: ICONS.jump,
        onClick: () => { void navigateTo(entry.path); },
      },
      {
        label: i18n.revealInExplorer,
        icon: ICONS.reveal,
        primary: true,
        onClick: async () => {
          try {
            await callTool('fv_reveal_in_explorer', { path: entry.path });
            showToast(i18n.toastRevealed);
          } catch (err) {
            showToast((err as Error).message, true);
          }
        },
      },
      {
        label: i18n.openTerminalHere,
        icon: ICONS.terminal,
        onClick: async () => {
          try {
            await callTool('fv_open_terminal', { path: entry.path });
            showToast(i18n.toastOpenedTerminal);
          } catch (err) {
            showToast((err as Error).message, true);
          }
        },
      },
      { separator: true },
      {
        label: i18n.newFile,
        icon: ICONS.newFile,
        onClick: () => promptCreateItem(entry.path, 'file'),
      },
      {
        label: i18n.newFolder,
        icon: ICONS.newFolder,
        onClick: () => promptCreateItem(entry.path, 'folder'),
      },
      {
        label: i18n.paste,
        icon: ICONS.paste,
        shortcut: 'Ctrl+V',
        disabled: !hasClipboard,
        onClick: () => { void performPaste(entry.path); },
      },
      { separator: true },
      {
        label: i18n.copyFullPath,
        icon: ICONS.copy,
        onClick: () => { void copyText(entry.path, i18n.copyFullPath); },
      },
      {
        label: i18n.copyRelPath,
        icon: ICONS.copy,
        onClick: () => { void copyText(entry.relativePath, i18n.copyRelPath); },
      },
      {
        label: i18n.copyFolderName,
        icon: ICONS.copy,
        onClick: () => { void copyText(entry.name, i18n.copyFolderName); },
      },
      {
        label: isPinned(entry.path) ? i18n.unpinFolder : i18n.pinFolder,
        icon: ICONS.pin,
        onClick: () => { void togglePinFolder(entry.path); },
      },
      ...(state.canUpdateModelContext
        ? [
            {
              label: i18n.attachToChat,
              icon: ICONS.chat,
              onClick: async () => {
                try {
                  await app.updateModelContext({
                    content: [{ type: 'text', text: `Folder: ${entry.path}` }],
                  });
                  showToast(i18n.toastAttached(entry.name));
                } catch (err) {
                  showToast((err as Error).message, true);
                }
              },
            } as ContextMenuItem,
          ]
        : []),
      { separator: true },
      {
        label: i18n.rename,
        icon: ICONS.edit,
        shortcut: 'F2',
        onClick: () => promptRenameItem(entry),
      },
      {
        label: i18n.copy,
        icon: ICONS.copy,
        shortcut: 'Ctrl+C',
        onClick: () => {
          state.clipboard = { mode: 'copy', entries: [entry] };
          renderClipboardBanner();
          renderTree();
        },
      },
      {
        label: i18n.cut,
        icon: ICONS.cut,
        shortcut: 'Ctrl+X',
        onClick: () => {
          state.clipboard = { mode: 'cut', entries: [entry] };
          renderClipboardBanner();
          renderTree();
        },
      },
      {
        label: i18n.moveToTrash,
        icon: ICONS.trash,
        shortcut: 'Del',
        danger: true,
        onClick: () => promptDeleteItem(entry),
      },
      { separator: true },
      {
        label: i18n.properties,
        icon: ICONS.info,
        shortcut: 'Alt+Enter',
        onClick: () => { void openPropertiesModal(entry); },
      },
    ];
    showContextMenu(items, x, y);
    return;
  }

  const fileItems: ContextMenuSpec[] = [
    {
      label: i18n.openInSidePane,
      icon: ICONS.openPane,
      onClick: () => { void openInSidePaneOrPreview(entry); },
    },
    {
      label: i18n.openWithDefault,
      icon: ICONS.openExternal,
      onClick: async () => {
        try {
          await callTool('fv_open_default', { path: entry.path });
          showToast(i18n.toastOpenedDefault);
        } catch (err) {
          showToast((err as Error).message, true);
        }
      },
    },
    {
      label: i18n.revealInExplorer,
      icon: ICONS.reveal,
      primary: true,
      onClick: async () => {
        try {
          await callTool('fv_reveal_in_explorer', { path: entry.path });
          showToast(i18n.toastRevealed);
        } catch (err) {
          showToast((err as Error).message, true);
        }
      },
    },
    {
      label: i18n.openTerminalHere,
      icon: ICONS.terminal,
      onClick: async () => {
        try {
          await callTool('fv_open_terminal', { path: entry.path });
          showToast(i18n.toastOpenedTerminal);
        } catch (err) {
          showToast((err as Error).message, true);
        }
      },
    },
    { separator: true },
    {
      label: i18n.copyFullPath,
      icon: ICONS.copy,
      onClick: () => { void copyText(entry.path, i18n.copyFullPath); },
    },
    {
      label: i18n.copyRelPath,
      icon: ICONS.copy,
      onClick: () => { void copyText(entry.relativePath, i18n.copyRelPath); },
    },
    {
      label: i18n.copyName,
      icon: ICONS.copy,
      onClick: () => { void copyText(entry.name, i18n.copyName); },
    },
    ...(state.canUpdateModelContext
      ? [
          {
            label: i18n.attachToChat,
            icon: ICONS.chat,
            onClick: async () => {
              try {
                await app.updateModelContext({
                  content: [{ type: 'text', text: `File: ${entry.path}` }],
                });
                showToast(i18n.toastAttached(entry.name));
              } catch (err) {
                showToast((err as Error).message, true);
              }
            },
          } as ContextMenuItem,
        ]
      : []),
    { separator: true },
    {
      label: i18n.rename,
      icon: ICONS.edit,
      shortcut: 'F2',
      onClick: () => promptRenameItem(entry),
    },
    {
      label: i18n.copy,
      icon: ICONS.copy,
      shortcut: 'Ctrl+C',
      onClick: () => {
        state.clipboard = { mode: 'copy', entries: [entry] };
        renderClipboardBanner();
        renderTree();
      },
    },
    {
      label: i18n.cut,
      icon: ICONS.cut,
      shortcut: 'Ctrl+X',
      onClick: () => {
        state.clipboard = { mode: 'cut', entries: [entry] };
        renderClipboardBanner();
        renderTree();
      },
    },
    {
      label: i18n.duplicate,
      icon: ICONS.copy,
      onClick: () => { void performDuplicate(entry); },
    },
    {
      label: i18n.moveToTrash,
      icon: ICONS.trash,
      shortcut: 'Del',
      danger: true,
      onClick: () => promptDeleteItem(entry),
    },
    { separator: true },
    {
      label: i18n.properties,
      icon: ICONS.info,
      shortcut: 'Alt+Enter',
      onClick: () => { void openPropertiesModal(entry); },
    },
  ];
  showContextMenu(fileItems, x, y);
}

function openBlankContextMenu(x: number, y: number) {
  if (!state.rootPath) return;
  const i18n = t(state.prefs.lang);
  const hasClipboard = Boolean(state.clipboard && state.clipboard.entries.length > 0);
  showContextMenu(
    [
      {
        label: i18n.newFile,
        icon: ICONS.newFile,
        onClick: () => promptCreateItem(state.rootPath, 'file'),
      },
      {
        label: i18n.newFolder,
        icon: ICONS.newFolder,
        onClick: () => promptCreateItem(state.rootPath, 'folder'),
      },
      {
        label: i18n.paste,
        icon: ICONS.paste,
        shortcut: 'Ctrl+V',
        disabled: !hasClipboard,
        onClick: () => { void performPaste(state.rootPath); },
      },
      { separator: true },
      {
        label: i18n.revealCurrent,
        icon: ICONS.reveal,
        primary: true,
        onClick: async () => {
          await callTool('fv_reveal_in_explorer', { path: state.rootPath });
          showToast(i18n.toastRevealed);
        },
      },
      {
        label: i18n.openTerminalCurrent,
        icon: ICONS.terminal,
        onClick: async () => {
          await callTool('fv_open_terminal', { path: state.rootPath });
          showToast(i18n.toastOpenedTerminal);
        },
      },
      {
        label: i18n.copyCurrentPath,
        icon: ICONS.copy,
        onClick: () => { void copyText(state.rootPath, i18n.copyCurrentPath); },
      },
      { separator: true },
      {
        label: i18n.refresh,
        icon: ICONS.refresh,
        onClick: () => { void refreshAll(); },
      },
    ],
    x,
    y
  );
}

function applyInitialPayload(payload: {
  platform?: string;
  initialPath?: string;
  parentPath?: string | null;
  selectedPath?: string | null;
  entries?: FsEntry[];
  projects?: ProjectInfo[];
  shortcuts?: ShortcutInfo[];
  drives?: ShortcutInfo[];
  preferences?: Partial<Prefs>;
}) {
  if (!payload || !payload.initialPath) return;
  state.initializedFromHost = true;
  state.platform = payload.platform || state.platform;
  state.rootPath = payload.initialPath;
  state.parentPath = payload.parentPath ?? null;
  state.projects = payload.projects || state.projects;
  state.shortcuts = payload.shortcuts || state.shortcuts;
  state.drives = payload.drives || state.drives;
  if (payload.preferences) {
    state.prefs = { ...state.prefs, ...payload.preferences };
  }
  state.childrenMap.clear();
  state.expanded.clear();
  state.childrenMap.set(payload.initialPath, payload.entries || []);
  state.selectedPath = payload.selectedPath || null;
  state.searchResults = null;

  applyToolbarChrome();
  renderLocationSelect();
  renderBreadcrumbs();
  renderClipboardBanner();
  renderTree();
}

function applyHostContext(ctx: ReturnType<App['getHostContext']>) {
  if (!ctx) return;
  if (ctx.theme === 'light' || ctx.theme === 'dark') {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
}

// Event Listeners
elLocationSelect.addEventListener('change', () => {
  const val = elLocationSelect.value;
  if (val === '__JUMP__') {
    elLocationSelect.value = state.rootPath;
    promptJumpPath();
    return;
  }
  if (val && val !== state.rootPath) {
    void navigateTo(val);
  }
});

btnNewFile.addEventListener('click', () => {
  if (!state.rootPath) return;
  const sel = state.selectedPath ? state.entryIndex.get(state.selectedPath) : null;
  const targetDir = sel?.isDirectory ? sel.path : sel ? getParentPath(sel.path) : state.rootPath;
  promptCreateItem(targetDir, 'file');
});

btnNewFolder.addEventListener('click', () => {
  if (!state.rootPath) return;
  const sel = state.selectedPath ? state.entryIndex.get(state.selectedPath) : null;
  const targetDir = sel?.isDirectory ? sel.path : sel ? getParentPath(sel.path) : state.rootPath;
  promptCreateItem(targetDir, 'folder');
});

btnRevealRoot.addEventListener('click', async () => {
  if (!state.rootPath) return;
  try {
    await callTool('fv_reveal_in_explorer', { path: state.rootPath });
    showToast(t(state.prefs.lang).toastRevealed);
  } catch (err) {
    showToast((err as Error).message, true);
  }
});

btnTerminalRoot.addEventListener('click', async () => {
  if (!state.rootPath) return;
  try {
    await callTool('fv_open_terminal', { path: state.rootPath });
    showToast(t(state.prefs.lang).toastOpenedTerminal);
  } catch (err) {
    showToast((err as Error).message, true);
  }
});

btnToggleHidden.addEventListener('click', async () => {
  state.prefs.showHidden = !state.prefs.showHidden;
  applyToolbarChrome();
  void callTool('fv_save_prefs', { showHidden: state.prefs.showHidden }).catch(() => {});
  await refreshAll();
});

btnSort.addEventListener('click', async () => {
  const order: Array<[Prefs['sortBy'], Prefs['sortDir']]> = [
    ['name', 'asc'],
    ['name', 'desc'],
    ['mtime', 'desc'],
    ['size', 'desc'],
  ];
  const idx = order.findIndex(
    ([b, d]) => b === state.prefs.sortBy && d === state.prefs.sortDir
  );
  const [nextBy, nextDir] = order[(idx + 1) % order.length];
  state.prefs.sortBy = nextBy;
  state.prefs.sortDir = nextDir;
  applyToolbarChrome();
  showToast(t(state.prefs.lang).sortLabel(nextBy, nextDir));
  void callTool('fv_save_prefs', { sortBy: nextBy, sortDir: nextDir }).catch(() => {});
  await refreshAll();
});

btnLang.addEventListener('click', () => {
  state.prefs.lang = state.prefs.lang === 'zh' ? 'en' : 'zh';
  applyToolbarChrome();
  renderLocationSelect();
  renderClipboardBanner();
  renderTree();
  void callTool('fv_save_prefs', { lang: state.prefs.lang }).catch(() => {});
});

btnRefresh.addEventListener('click', () => {
  void refreshAll();
});

btnUp.addEventListener('click', () => {
  if (state.parentPath) {
    void navigateTo(state.parentPath);
  }
});

btnCopyCwd.addEventListener('click', () => {
  if (state.rootPath) {
    void copyText(state.rootPath, t(state.prefs.lang).copyCurrentPath);
  }
});

btnJumpPath.addEventListener('click', promptJumpPath);

let searchTimer: number | null = null;
elSearchInput.addEventListener('input', () => {
  state.searchQuery = elSearchInput.value;
  elSearchClear.classList.toggle('hidden', !state.searchQuery);
  if (state.deepSearch) {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      void runDeepSearch();
    }, 240);
  } else {
    renderTree();
  }
});

elSearchClear.addEventListener('click', () => {
  elSearchInput.value = '';
  state.searchQuery = '';
  state.searchResults = null;
  elSearchClear.classList.add('hidden');
  renderTree();
});

elSearchMode.addEventListener('click', () => {
  state.deepSearch = !state.deepSearch;
  state.searchResults = null;
  applyToolbarChrome();
  if (state.deepSearch && state.searchQuery.trim()) {
    void runDeepSearch();
  } else {
    renderTree();
  }
});

elBannerPaste.addEventListener('click', () => {
  const sel = state.selectedPath ? state.entryIndex.get(state.selectedPath) : null;
  const targetDir = sel?.isDirectory ? sel.path : state.rootPath;
  if (targetDir) void performPaste(targetDir);
});

elBannerClear.addEventListener('click', () => {
  state.clipboard = null;
  renderClipboardBanner();
  renderTree();
});

elTreeContainer.addEventListener('contextmenu', (ev) => {
  if (ev.target === elTreeContainer || (ev.target as HTMLElement).classList.contains('fv-empty-state')) {
    ev.preventDefault();
    openBlankContextMenu(ev.clientX, ev.clientY);
  }
});

document.addEventListener('mousedown', (ev) => {
  if (!elContextMenu.classList.contains('hidden') && !elContextMenu.contains(ev.target as Node)) {
    closeContextMenu();
  }
});

elModalBackdrop.addEventListener('mousedown', (ev) => {
  if (ev.target === elModalBackdrop) {
    closeModal();
  }
});

window.addEventListener('blur', closeContextMenu);

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (!elContextMenu.classList.contains('hidden')) {
      closeContextMenu();
      return;
    }
    if (!elModalBackdrop.classList.contains('hidden')) {
      closeModal();
      return;
    }
  }

  // Do not hijack shortcuts while typing in inputs or modals
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;
  if (!elModalBackdrop.classList.contains('hidden')) return;

  const sel = state.selectedPath ? state.entryIndex.get(state.selectedPath) : null;

  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (state.visiblePaths.length === 0) return;
    const idx = state.selectedPath ? state.visiblePaths.indexOf(state.selectedPath) : -1;
    const nextIdx =
      ev.key === 'ArrowDown'
        ? Math.min(state.visiblePaths.length - 1, idx + 1)
        : Math.max(0, idx <= 0 ? 0 : idx - 1);
    const nextPath = state.visiblePaths[nextIdx];
    selectPath(nextPath);
    const rowEl = elTreeContainer.querySelector(`[data-path="${CSS.escape(nextPath)}"]`);
    rowEl?.scrollIntoView({ block: 'nearest' });
    return;
  }

  if (!sel) return;

  if (ev.key === 'ArrowRight' && sel.isDirectory && !state.expanded.has(sel.path)) {
    ev.preventDefault();
    void toggleFolder(sel.path);
  } else if (ev.key === 'ArrowLeft' && sel.isDirectory && state.expanded.has(sel.path)) {
    ev.preventDefault();
    void toggleFolder(sel.path);
  } else if (ev.key === 'Enter' && ev.altKey) {
    ev.preventDefault();
    void openPropertiesModal(sel);
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    if (sel.isDirectory) void navigateTo(sel.path);
    else void openInSidePaneOrPreview(sel);
  } else if (ev.key === 'F2') {
    ev.preventDefault();
    promptRenameItem(sel);
  } else if (ev.key === 'Delete') {
    ev.preventDefault();
    promptDeleteItem(sel);
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c') {
    ev.preventDefault();
    state.clipboard = { mode: 'copy', entries: [sel] };
    renderClipboardBanner();
    renderTree();
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'x') {
    ev.preventDefault();
    state.clipboard = { mode: 'cut', entries: [sel] };
    renderClipboardBanner();
    renderTree();
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'v') {
    if (state.clipboard?.entries.length) {
      ev.preventDefault();
      const targetDir = sel.isDirectory ? sel.path : getParentPath(sel.path);
      void performPaste(targetDir);
    }
  }
});

// Wire MCP Apps SDK BEFORE connect()
app.ontoolinput = () => {
  if (!state.initializedFromHost) {
    elStatusLeft.textContent = t(state.prefs.lang).loading;
  }
};

app.ontoolresult = (result) => {
  if (result?.structuredContent) {
    applyInitialPayload(result.structuredContent as Parameters<typeof applyInitialPayload>[0]);
  }
};

app.onhostcontextchanged = (ctx) => {
  applyHostContext(ctx as ReturnType<App['getHostContext']>);
};

async function bootstrap() {
  applyToolbarChrome();
  try {
    await app.connect();
    applyHostContext(app.getHostContext());
    const caps = app.getHostCapabilities();
    state.canUpdateModelContext = Boolean(caps?.updateModelContext);

    // Fallback init if host opened the pane without delivering an immediate tool result
    window.setTimeout(async () => {
      if (!state.initializedFromHost) {
        try {
          const payload = await callTool<Parameters<typeof applyInitialPayload>[0]>('fv_init', {});
          applyInitialPayload(payload);
        } catch (err) {
          showToast((err as Error).message, true);
        }
      }
    }, 180);
  } catch (err) {
    showToast(`Connect failed: ${(err as Error).message}`, true);
  }
}

void bootstrap();

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import {
  copyToOsClipboard,
  discoverAntigravityProjects,
  listDrivesAndShortcuts,
  moveToTrash,
  normalizeFsPath,
  openTerminalAt,
  openWithDefaultApp,
  revealInExplorer,
} from './os-actions.mjs';

const APP_RESOURCE_URI = 'ui://agy-fileview/explorer.html';
const MAX_PREVIEW_BYTES = 64 * 1024;
const MAX_HASH_BYTES = 50 * 1024 * 1024;
const DEFAULT_SKIP_SEARCH_DIRS = new Set([
  '.git',
  'node_modules',
  '$RECYCLE.BIN',
  'System Volume Information',
  '.next',
  '.nuxt',
  '__pycache__',
]);
const SYSTEM_SKIP_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information']);
const WINDOWS_ILLEGAL_NAME_RE = /[<>:"/\\|?*\x00-\x1f]/;
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

function resolvePluginRoot() {
  if (process.env.PLUGIN_ROOT) {
    return path.resolve(process.env.PLUGIN_ROOT);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Handles running either from src/server.mjs or dist/server.mjs
  return path.resolve(here, '..');
}

const PLUGIN_ROOT = resolvePluginRoot();

function getStateFilePath() {
  const dataDir = process.env.PLUGIN_DATA || path.join(os.tmpdir(), 'agy-fileview-data');
  return path.join(dataDir, 'state.json');
}

const DEFAULT_PREFS = {
  lastPath: '',
  pinnedFolders: [],
  showHidden: false,
  sortBy: 'name',
  sortDir: 'asc',
  lang: 'zh',
};

async function loadPrefs() {
  try {
    const raw = await fs.readFile(getStateFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      pinnedFolders: Array.isArray(parsed?.pinnedFolders) ? parsed.pinnedFolders : [],
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

async function savePrefs(patch) {
  const current = await loadPrefs();
  const next = { ...current };
  if (typeof patch.lastPath === 'string') next.lastPath = patch.lastPath;
  if (typeof patch.showHidden === 'boolean') next.showHidden = patch.showHidden;
  if (Array.isArray(patch.pinnedFolders)) {
    next.pinnedFolders = Array.from(new Set(patch.pinnedFolders.filter((p) => typeof p === 'string' && p.trim())));
  }
  if (patch.sortBy === 'name' || patch.sortBy === 'mtime' || patch.sortBy === 'size') {
    next.sortBy = patch.sortBy;
  }
  if (patch.sortDir === 'asc' || patch.sortDir === 'desc') {
    next.sortDir = patch.sortDir;
  }
  if (patch.lang === 'zh' || patch.lang === 'en') {
    next.lang = patch.lang;
  }

  const statePath = getStateFilePath();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function validateItemName(name) {
  if (typeof name !== 'string') {
    throw new Error('Item name must be a string');
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Item name cannot be empty');
  }
  if (trimmed !== name) {
    throw new Error('Item name cannot have leading or trailing spaces');
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error('Invalid item name');
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    throw new Error('Item name cannot contain path separators');
  }
  if (process.platform === 'win32') {
    if (WINDOWS_ILLEGAL_NAME_RE.test(trimmed)) {
      throw new Error('Item name contains illegal Windows characters (< > : " / \\ | ? *)');
    }
    if (trimmed.endsWith('.')) {
      throw new Error('Windows file or folder names cannot end with a dot');
    }
    const stem = trimmed.split('.')[0].toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(stem)) {
      throw new Error(`"${trimmed}" is a reserved Windows device name`);
    }
  }
  return trimmed;
}

function isSameOrSubPath(parentPath, candidatePath) {
  const normParent = normalizeFsPath(parentPath);
  const normCandidate = normalizeFsPath(candidatePath);
  if (process.platform === 'win32') {
    const pLower = normParent.toLowerCase();
    const cLower = normCandidate.toLowerCase();
    if (pLower === cLower) return true;
    const rel = path.win32.relative(pLower, cLower);
    return Boolean(rel && !rel.startsWith('..') && !path.win32.isAbsolute(rel));
  }
  if (normParent === normCandidate) return true;
  const rel = path.relative(normParent, normCandidate);
  return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function computeRelativePath(rootPath, fullPath) {
  if (!rootPath) return path.basename(fullPath);
  const rel = path.relative(rootPath, fullPath);
  return rel || '.';
}

function serializeEntry(fullPath, rootPath, stat, isSymlink = false) {
  const name = path.basename(fullPath) || fullPath;
  const isDirectory = stat.isDirectory();
  const ext = isDirectory ? '' : path.extname(name).toLowerCase();
  return {
    name,
    path: fullPath,
    relativePath: computeRelativePath(rootPath, fullPath),
    fileUri: pathToFileURL(fullPath).href,
    isDirectory,
    isSymlink,
    size: isDirectory ? 0 : stat.size,
    mtimeMs: stat.mtimeMs,
    ext,
    isHidden: name.startsWith('.'),
  };
}

function sortEntries(entries, sortBy = 'name', sortDir = 'asc') {
  const dirMul = sortDir === 'desc' ? -1 : 1;
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    if (sortBy === 'mtime') {
      const diff = (a.mtimeMs - b.mtimeMs) * dirMul;
      if (diff !== 0) return diff;
    } else if (sortBy === 'size' && !a.isDirectory) {
      const diff = (a.size - b.size) * dirMul;
      if (diff !== 0) return diff;
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) * dirMul;
  });
}

async function pathExists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveUniqueTarget(dirPath, originalName, isDirectory) {
  const direct = path.join(dirPath, originalName);
  if (!(await pathExists(direct))) {
    return direct;
  }

  let stem = originalName;
  let ext = '';
  if (!isDirectory) {
    const dotIdx = originalName.lastIndexOf('.');
    if (dotIdx > 0) {
      stem = originalName.slice(0, dotIdx);
      ext = originalName.slice(dotIdx);
    }
  }

  const firstCopy = path.join(dirPath, `${stem} - Copy${ext}`);
  if (!(await pathExists(firstCopy))) {
    return firstCopy;
  }

  for (let i = 2; i < 1000; i += 1) {
    const candidate = path.join(dirPath, `${stem} - Copy (${i})${ext}`);
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }
  throw new Error(`Could not find an available copy name for "${originalName}"`);
}

function getParentDirPath(dirPath) {
  const resolved = normalizeFsPath(dirPath);
  const parent = path.dirname(resolved);
  return parent === resolved ? null : parent;
}

async function listDirectory(dirPath, options = {}) {
  const {
    rootPath = dirPath,
    showHidden = false,
    sortBy = 'name',
    sortDir = 'asc',
  } = options;

  const resolved = normalizeFsPath(dirPath);
  const dirStat = await fs.stat(resolved);
  if (!dirStat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }

  const dirents = await fs.readdir(resolved, { withFileTypes: true });
  const entries = [];

  await Promise.all(
    dirents.map(async (dirent) => {
      if (!showHidden && dirent.name.startsWith('.')) return;
      const fullPath = path.join(resolved, dirent.name);
      try {
        const isSymlink = dirent.isSymbolicLink();
        const st = isSymlink ? await fs.stat(fullPath).catch(() => fs.lstat(fullPath)) : await fs.lstat(fullPath);
        entries.push(serializeEntry(fullPath, rootPath, st, isSymlink));
      } catch {
        // Ignore locked/unreadable system entries such as Windows junctions without permissions
      }
    })
  );

  sortEntries(entries, sortBy, sortDir);

  return {
    path: resolved,
    parentPath: getParentDirPath(resolved),
    entries,
  };
}

async function searchFiles({ rootPath, query, showHidden = false, maxResults = 150 }) {
  const resolvedRoot = normalizeFsPath(rootPath);
  const needle = (query || '').trim().toLowerCase();
  if (!needle) {
    return { rootPath: resolvedRoot, results: [], truncated: false, searchedCount: 0 };
  }

  const limit = Math.max(1, Math.min(maxResults, 300));
  const deadline = Date.now() + 2500;
  const queue = [resolvedRoot];
  const results = [];
  let truncated = false;
  let searchedCount = 0;

  while (queue.length > 0) {
    if (Date.now() > deadline || results.length >= limit) {
      truncated = true;
      break;
    }

    const current = queue.shift();
    let dirents;
    try {
      dirents = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      if (Date.now() > deadline || results.length >= limit) {
        truncated = true;
        break;
      }

      const name = dirent.name;
      if (SYSTEM_SKIP_DIRS.has(name)) continue;
      if (!showHidden && name.startsWith('.')) continue;

      const fullPath = path.join(current, name);
      const isSymlink = dirent.isSymbolicLink();
      if (isSymlink) continue;

      let st;
      try {
        st = await fs.lstat(fullPath);
      } catch {
        continue;
      }

      searchedCount += 1;
      const isDir = st.isDirectory();

      if (name.toLowerCase().includes(needle)) {
        results.push(serializeEntry(fullPath, resolvedRoot, st, false));
        if (results.length >= limit) {
          truncated = true;
          break;
        }
      }

      if (isDir) {
        if (!showHidden && DEFAULT_SKIP_SEARCH_DIRS.has(name)) continue;
        queue.push(fullPath);
      }
    }
  }

  sortEntries(results, 'name', 'asc');
  return { rootPath: resolvedRoot, results, truncated, searchedCount };
}

async function computeFolderStats(dirPath) {
  const deadline = Date.now() + 1000;
  const maxItems = 5000;
  const queue = [dirPath];
  let files = 0;
  let folders = 0;
  let totalSize = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (Date.now() > deadline || files + folders >= maxItems) {
      truncated = true;
      break;
    }
    const current = queue.shift();
    let dirents;
    try {
      dirents = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      if (Date.now() > deadline || files + folders >= maxItems) {
        truncated = true;
        break;
      }
      if (SYSTEM_SKIP_DIRS.has(dirent.name)) continue;
      const fullPath = path.join(current, dirent.name);
      try {
        const st = await fs.lstat(fullPath);
        if (st.isDirectory()) {
          folders += 1;
          if (!dirent.isSymbolicLink()) queue.push(fullPath);
        } else {
          files += 1;
          totalSize += st.size;
        }
      } catch {
        // skip unreadable entries
      }
    }
  }

  return { files, folders, totalSize, truncated };
}

async function getProperties(targetPath, computeHash = false) {
  const resolved = normalizeFsPath(targetPath);
  const lst = await fs.lstat(resolved);
  const isSymlink = lst.isSymbolicLink();
  const st = isSymlink ? await fs.stat(resolved).catch(() => lst) : lst;
  const isDirectory = st.isDirectory();

  let readonly = false;
  try {
    await fs.access(resolved, fs.constants.W_OK);
  } catch {
    readonly = true;
  }

  let folderStats = null;
  if (isDirectory) {
    folderStats = await computeFolderStats(resolved);
  }

  let sha256 = null;
  let hashError = null;
  if (computeHash && !isDirectory) {
    if (st.size > MAX_HASH_BYTES) {
      hashError = `File exceeds ${Math.round(MAX_HASH_BYTES / 1024 / 1024)} MB hash limit`;
    } else {
      const hash = crypto.createHash('sha256');
      const data = await fs.readFile(resolved);
      hash.update(data);
      sha256 = hash.digest('hex');
    }
  }

  return {
    name: path.basename(resolved) || resolved,
    path: resolved,
    parentPath: getParentDirPath(resolved),
    fileUri: pathToFileURL(resolved).href,
    isDirectory,
    isSymlink,
    size: isDirectory ? (folderStats?.totalSize ?? 0) : st.size,
    folderStats,
    birthtimeMs: st.birthtimeMs,
    mtimeMs: st.mtimeMs,
    atimeMs: st.atimeMs,
    mode: `0${(st.mode & 0o777).toString(8)}`,
    readonly,
    ext: isDirectory ? '' : path.extname(resolved).toLowerCase(),
    sha256,
    hashError,
  };
}

async function readPreview(targetPath) {
  const resolved = normalizeFsPath(targetPath);
  const st = await fs.stat(resolved);
  if (st.isDirectory()) {
    throw new Error('Cannot preview a directory as text');
  }

  const readLen = Math.min(st.size, MAX_PREVIEW_BYTES);
  const handle = await fs.open(resolved, 'r');
  try {
    const buf = Buffer.alloc(readLen);
    const { bytesRead } = await handle.read(buf, 0, readLen, 0);
    const slice = buf.subarray(0, bytesRead);
    const isBinary = slice.includes(0);
    return {
      path: resolved,
      name: path.basename(resolved),
      size: st.size,
      truncated: st.size > MAX_PREVIEW_BYTES,
      isBinary,
      text: isBinary ? '' : slice.toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}

async function tryGetClientRoots(mcpServer) {
  try {
    const caps = mcpServer.server.getClientCapabilities();
    if (!caps?.roots) return [];
    const result = await Promise.race([
      mcpServer.server.listRoots(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('roots timeout')), 350)),
    ]);
    const roots = [];
    for (const root of result?.roots || []) {
      if (root?.uri?.startsWith('file://')) {
        try {
          const p = normalizeFsPath(fileURLToPath(root.uri));
          const st = await fs.stat(p);
          if (st.isDirectory()) {
            roots.push({ name: root.name || path.basename(p) || p, path: p });
          }
        } catch {
          // ignore invalid root
        }
      }
    }
    return roots;
  } catch {
    return [];
  }
}

async function resolveInitialContext(mcpServer, requestedPath) {
  const [prefs, projects, { shortcuts, drives }, clientRoots] = await Promise.all([
    loadPrefs(),
    discoverAntigravityProjects(),
    listDrivesAndShortcuts(),
    tryGetClientRoots(mcpServer),
  ]);

  let initialPath = '';
  let selectedPath = null;

  if (requestedPath && requestedPath.trim()) {
    try {
      const candidate = normalizeFsPath(requestedPath);
      const st = await fs.stat(candidate);
      if (st.isDirectory()) {
        initialPath = candidate;
      } else {
        initialPath = path.dirname(candidate);
        selectedPath = candidate;
      }
    } catch {
      // fall through to auto discovery
    }
  }

  const fallbacks = [
    clientRoots[0]?.path,
    projects.find((p) => p.isActive)?.path,
    prefs.lastPath,
    projects[0]?.path,
    process.cwd(),
    os.homedir(),
  ];

  if (!initialPath) {
    for (const candidate of fallbacks) {
      if (!candidate) continue;
      try {
        const norm = normalizeFsPath(candidate);
        const st = await fs.stat(norm);
        if (st.isDirectory()) {
          initialPath = norm;
          break;
        }
      } catch {
        // try next fallback
      }
    }
  }

  const listing = await listDirectory(initialPath, {
    rootPath: initialPath,
    showHidden: prefs.showHidden,
    sortBy: prefs.sortBy,
    sortDir: prefs.sortDir,
  });

  // Merge client roots into projects list if not already present
  const knownProjectPaths = new Set(
    projects.map((p) => (process.platform === 'win32' ? p.path.toLowerCase() : p.path))
  );
  const mergedProjects = [...projects];
  for (const cr of clientRoots) {
    const key = process.platform === 'win32' ? cr.path.toLowerCase() : cr.path;
    if (!knownProjectPaths.has(key)) {
      knownProjectPaths.add(key);
      mergedProjects.unshift({
        id: 'workspace-root',
        name: cr.name,
        path: cr.path,
        isActive: true,
      });
    }
  }

  return {
    platform: process.platform,
    initialPath: listing.path,
    parentPath: listing.parentPath,
    selectedPath,
    entries: listing.entries,
    projects: mergedProjects,
    shortcuts,
    drives,
    preferences: prefs,
  };
}

function jsonToolResult(text, structuredContent) {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

function errorToolResult(err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
  };
}

function createServer() {
  const server = new McpServer(
    { name: 'agy-fileview', version: '1.0.0' },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

  // 1. UI HTML Resource (read fresh on every mount for fast iteration)
  registerAppResource(
    server,
    'FileView Explorer UI',
    APP_RESOURCE_URI,
    {
      description: 'Interactive file explorer UI with full right-click file operations',
      mimeType: RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    async () => {
      const htmlPath = process.env.AGY_FILEVIEW_HTML || path.join(PLUGIN_ROOT, 'dist', 'app.html');
      const html = await fs.readFile(htmlPath, 'utf8');
      return {
        contents: [
          {
            uri: APP_RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: { ui: { prefersBorder: false } },
          },
        ],
      };
    }
  );

  // 2. Primary Entrypoint Tool (Side Panel + Full-Page Sidebar + Agent-callable)
  registerAppTool(
    server,
    'open_file_explorer',
    {
      title: 'FileView',
      description:
        'Open the FileView enhanced file explorer in the side panel or full-page view with right-click Reveal in Explorer, open default app, open terminal, copy path, rename, copy/cut/paste, duplicate, recycle bin delete, and chat context attachment.',
      inputSchema: {
        path: z.string().optional().describe('Optional directory or file path to open in FileView'),
      },
      _meta: {
        ui: { resourceUri: APP_RESOURCE_URI },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'FileView' },
            { type: 'global', title: 'FileView' },
          ],
        },
      },
    },
    async (args = {}) => {
      try {
        const ctx = await resolveInitialContext(server, args?.path);
        return jsonToolResult(
          `Opened FileView at ${ctx.initialPath} (${ctx.entries.length} items).`,
          ctx
        );
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  // 3. Model + App convenience tool to directly reveal any path in OS file manager
  server.registerTool(
    'reveal_in_explorer',
    {
      title: 'Reveal in Explorer',
      description: 'Open the OS file manager (Windows Explorer / Finder) and highlight the specified file or folder.',
      inputSchema: {
        path: z.string().describe('Absolute path of the file or folder to reveal'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: targetPath }) => {
      try {
        const res = await revealInExplorer(targetPath);
        return jsonToolResult(`Revealed in file manager: ${res.path}`, res);
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  // App-only helper tools
  const APP_ONLY_META = { ui: { visibility: ['app'] } };

  server.registerTool(
    'fv_init',
    {
      description: 'Initialize or refresh FileView state, discovered Antigravity projects, shortcuts, drives, and directory entries.',
      inputSchema: {
        path: z.string().optional(),
      },
      _meta: APP_ONLY_META,
    },
    async (args = {}) => {
      try {
        const ctx = await resolveInitialContext(server, args?.path);
        return jsonToolResult(`Initialized FileView at ${ctx.initialPath}`, ctx);
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  server.registerTool(
    'fv_list_dir',
    {
      description: 'List contents of a directory.',
      inputSchema: {
        path: z.string(),
        rootPath: z.string().optional(),
        showHidden: z.boolean().optional(),
        sortBy: z.enum(['name', 'mtime', 'size']).optional(),
        sortDir: z.enum(['asc', 'desc']).optional(),
      },
      _meta: APP_ONLY_META,
    },
    async (args) => {
      try {
        const res = await listDirectory(args.path, {
          rootPath: args.rootPath || args.path,
          showHidden: Boolean(args.showHidden),
          sortBy: args.sortBy || 'name',
          sortDir: args.sortDir || 'asc',
        });
        return jsonToolResult(`Listed ${res.entries.length} items in ${res.path}`, res);
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  server.registerTool(
    'fv_search_files',
    {
      description: 'Search files and folders recursively under rootPath.',
      inputSchema: {
        rootPath: z.string(),
        query: z.string(),
        showHidden: z.boolean().optional(),
        maxResults: z.number().int().positive().max(300).optional(),
      },
      _meta: APP_ONLY_META,
    },
    async (args) => {
      try {
        const res = await searchFiles(args);
        return jsonToolResult(`Found ${res.results.length} matches`, res);
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  server.registerTool(
    'fv_reveal_in_explorer',
    {
      description: 'Reveal file or folder in OS file manager.',
      inputSchema: { path: z.string() },
      _meta: APP_ONLY_META,
    },
    async ({ path: targetPath }) => {
      try {
        const res = await revealInExplorer(targetPath);
        return jsonToolResult(`Revealed ${res.path}`, res);
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  server.registerTool(
    'fv_open_default',
    {
      description: 'Open file or folder using OS default application.',
      inputSchema: { path: z.string() },
      _meta: APP_ONLY_META,
    },
    async ({ path: targetPath }) => {
      try {
        const res = await openWithDefaultApp(targetPath);
        return jsonToolResult(`Opened ${res.path}`, res);
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  server.registerTool(
    'fv_open_terminal',
    {
      description: 'Open system terminal at target directory.',
      inputSchema: { path: z.string() },
      _meta: APP_ONLY_META,
    },
    async ({ path: targetPath }) => {
      try {
        const res = await openTerminalAt(targetPath);
        return jsonToolResult(`Opened ${res.terminal} at ${res.dirPath}`, res);
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  server.registerTool(
    'fv_copy_clipboard',
    {
      description: 'Copy text to the OS clipboard as fallback when iframe Clipboard API is restricted.',
      inputSchema: { text: z.string() },
      _meta: APP_ONLY_META,
    },
    async ({ text }) => {
      try {
        const res = await copyToOsClipboard(text);
        return jsonToolResult('Copied to clipboard', res);
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  server.registerTool(
    'fv_create_item',
    {
      description: 'Create a new empty file or folder inside parentPath.',
      inputSchema: {
        parentPath: z.string(),
        name: z.string(),
        type: z.enum(['file', 'folder']),
        rootPath: z.string().optional(),
      },
      _meta: APP_ONLY_META,
    },
    async ({ parentPath, name, type, rootPath }) => {
      try {
        const resolvedParent = normalizeFsPath(parentPath);
        const parentStat = await fs.stat(resolvedParent);
        if (!parentStat.isDirectory()) {
          throw new Error(`Parent is not a directory: ${resolvedParent}`);
        }
        const safeName = validateItemName(name);
        const target = path.join(resolvedParent, safeName);
        if (path.dirname(target) !== resolvedParent) {
          throw new Error('Target escapes parent directory');
        }
        if (await pathExists(target)) {
          throw new Error(`"${safeName}" already exists`);
        }

        if (type === 'folder') {
          await fs.mkdir(target);
        } else {
          await fs.writeFile(target, '', { flag: 'wx' });
        }

        const st = await fs.lstat(target);
        const entry = serializeEntry(target, rootPath || resolvedParent, st, false);
        return jsonToolResult(`Created ${type}: ${target}`, { entry });
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  server.registerTool(
    'fv_rename_item',
    {
      description: 'Rename a file or folder.',
      inputSchema: {
        path: z.string(),
        newName: z.string(),
        rootPath: z.string().optional(),
      },
      _meta: APP_ONLY_META,
    },
    async ({ path: targetPath, newName, rootPath }) => {
      try {
        const resolved = normalizeFsPath(targetPath);
        await fs.lstat(resolved);
        const safeName = validateItemName(newName);
        const parentDir = path.dirname(resolved);
        const nextPath = path.join(parentDir, safeName);
        if (path.dirname(nextPath) !== parentDir) {
          throw new Error('Target escapes parent directory');
        }
        if (resolved === nextPath) {
          const st = await fs.lstat(resolved);
          return jsonToolResult('Name unchanged', {
            entry: serializeEntry(resolved, rootPath || parentDir, st, st.isSymbolicLink()),
          });
        }

        const isCaseOnlyRename =
          process.platform === 'win32' && resolved.toLowerCase() === nextPath.toLowerCase();
        if (!isCaseOnlyRename && (await pathExists(nextPath))) {
          throw new Error(`"${safeName}" already exists in this folder`);
        }

        await fs.rename(resolved, nextPath);
        const st = await fs.lstat(nextPath);
        return jsonToolResult(`Renamed to ${nextPath}`, {
          oldPath: resolved,
          entry: serializeEntry(nextPath, rootPath || parentDir, st, st.isSymbolicLink()),
        });
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  server.registerTool(
    'fv_copy_or_move',
    {
      description: 'Copy or move files/folders into targetDir.',
      inputSchema: {
        sources: z.array(z.string()).min(1),
        targetDir: z.string(),
        mode: z.enum(['copy', 'move']),
        rootPath: z.string().optional(),
      },
      _meta: APP_ONLY_META,
    },
    async ({ sources, targetDir, mode, rootPath }) => {
      try {
        const resolvedTargetDir = normalizeFsPath(targetDir);
        const targetStat = await fs.stat(resolvedTargetDir);
        if (!targetStat.isDirectory()) {
          throw new Error(`Target is not a directory: ${resolvedTargetDir}`);
        }

        const results = [];
        for (const rawSource of sources) {
          const src = normalizeFsPath(rawSource);
          const srcStat = await fs.lstat(src);
          const isDir = srcStat.isDirectory();

          if (isDir && isSameOrSubPath(src, resolvedTargetDir)) {
            throw new Error(`Cannot ${mode} folder "${path.basename(src)}" into itself or its subfolder`);
          }

          if (mode === 'move') {
            const srcParent = path.dirname(src);
            const sameParent =
              process.platform === 'win32'
                ? srcParent.toLowerCase() === resolvedTargetDir.toLowerCase()
                : srcParent === resolvedTargetDir;
            if (sameParent) {
              results.push(serializeEntry(src, rootPath || resolvedTargetDir, srcStat, srcStat.isSymbolicLink()));
              continue;
            }
          }

          const dest = await resolveUniqueTarget(resolvedTargetDir, path.basename(src), isDir);
          if (mode === 'copy') {
            await fs.cp(src, dest, { recursive: true, force: false, errorOnExist: true });
          } else {
            try {
              await fs.rename(src, dest);
            } catch (err) {
              if (err && err.code === 'EXDEV') {
                await fs.cp(src, dest, { recursive: true, force: false, errorOnExist: true });
                await fs.rm(src, { recursive: true });
              } else {
                throw err;
              }
            }
          }

          const destStat = await fs.lstat(dest);
          results.push(
            serializeEntry(dest, rootPath || resolvedTargetDir, destStat, destStat.isSymbolicLink())
          );
        }

        return jsonToolResult(
          `${mode === 'copy' ? 'Copied' : 'Moved'} ${results.length} item(s) to ${resolvedTargetDir}`,
          { mode, targetDir: resolvedTargetDir, entries: results }
        );
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  server.registerTool(
    'fv_duplicate_item',
    {
      description: 'Create a duplicate copy of a file or folder in the same parent directory.',
      inputSchema: {
        path: z.string(),
        rootPath: z.string().optional(),
      },
      _meta: APP_ONLY_META,
    },
    async ({ path: targetPath, rootPath }) => {
      try {
        const src = normalizeFsPath(targetPath);
        const srcStat = await fs.lstat(src);
        const parentDir = path.dirname(src);
        const dest = await resolveUniqueTarget(parentDir, path.basename(src), srcStat.isDirectory());
        await fs.cp(src, dest, { recursive: true, force: false, errorOnExist: true });
        const destStat = await fs.lstat(dest);
        const entry = serializeEntry(dest, rootPath || parentDir, destStat, destStat.isSymbolicLink());
        return jsonToolResult(`Duplicated to ${dest}`, { entry });
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  server.registerTool(
    'fv_delete_item',
    {
      description: 'Move files or folders to the OS Recycle Bin / Trash (or delete permanently if permanent=true).',
      inputSchema: {
        paths: z.array(z.string()).min(1),
        permanent: z.boolean().optional(),
      },
      _meta: APP_ONLY_META,
    },
    async ({ paths, permanent = false }) => {
      try {
        if (permanent) {
          const deleted = [];
          for (const p of paths) {
            const resolved = normalizeFsPath(p);
            await fs.lstat(resolved);
            await fs.rm(resolved, { recursive: true, force: false });
            deleted.push(resolved);
          }
          return jsonToolResult(`Permanently deleted ${deleted.length} item(s)`, {
            deleted,
            permanent: true,
          });
        }
        const res = await moveToTrash(paths);
        return jsonToolResult(`Moved ${res.trashed.length} item(s) to Recycle Bin`, {
          deleted: res.trashed,
          permanent: false,
        });
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  server.registerTool(
    'fv_get_properties',
    {
      description: 'Inspect detailed file or folder properties (size, timestamps, permissions, optional SHA-256).',
      inputSchema: {
        path: z.string(),
        computeHash: z.boolean().optional(),
      },
      _meta: APP_ONLY_META,
    },
    async ({ path: targetPath, computeHash = false }) => {
      try {
        const props = await getProperties(targetPath, computeHash);
        return jsonToolResult(`Properties for ${props.path}`, props);
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  server.registerTool(
    'fv_read_preview',
    {
      description: 'Read a bounded UTF-8 text preview (up to 64 KB) for fallback file viewing.',
      inputSchema: {
        path: z.string(),
      },
      _meta: APP_ONLY_META,
    },
    async ({ path: targetPath }) => {
      try {
        const preview = await readPreview(targetPath);
        return jsonToolResult(`Previewed ${preview.name}`, preview);
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  server.registerTool(
    'fv_save_prefs',
    {
      description: 'Persist FileView user preferences (lastPath, pinnedFolders, showHidden, sortBy, sortDir, lang).',
      inputSchema: {
        lastPath: z.string().optional(),
        showHidden: z.boolean().optional(),
        pinnedFolders: z.array(z.string()).optional(),
        sortBy: z.enum(['name', 'mtime', 'size']).optional(),
        sortDir: z.enum(['asc', 'desc']).optional(),
        lang: z.enum(['zh', 'en']).optional(),
      },
      _meta: APP_ONLY_META,
    },
    async (args) => {
      try {
        const next = await savePrefs(args);
        return jsonToolResult('Saved FileView preferences', { preferences: next });
      } catch (err) {
        return errorToolResult(err);
      }
    }
  );

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[agy-fileview] Fatal server error:', err);
  process.exit(1);
});

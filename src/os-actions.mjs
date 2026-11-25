import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

async function runPowerShell(script, envVars = {}, timeout = 30000) {
  return execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)],
    {
      env: { ...process.env, ...envVars },
      windowsHide: true,
      timeout,
    }
  );
}

export function normalizeFsPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('Path is required');
  }
  const trimmed = targetPath.trim();
  if (!trimmed) {
    throw new Error('Path cannot be empty');
  }
  if (process.platform === 'win32' && /^[a-zA-Z]:$/.test(trimmed)) {
    return `${trimmed.toUpperCase()}\\`;
  }
  return path.resolve(trimmed);
}

export async function revealInExplorer(targetPath) {
  const resolved = normalizeFsPath(targetPath);
  const stat = await fs.stat(resolved);

  if (process.platform === 'win32') {
    const winPath = path.win32.resolve(resolved);
    if (winPath.includes('"')) {
      throw new Error('Path cannot contain double quotes');
    }
    const isDriveRoot = /^[a-zA-Z]:\\$/.test(winPath);
    const args = isDriveRoot ? [winPath] : [`/select,"${winPath}"`];
    const child = spawn('explorer.exe', args, {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: !isDriveRoot,
    });
    child.unref();
    return { path: winPath, isDirectory: stat.isDirectory() };
  }

  if (process.platform === 'darwin') {
    await execFileAsync('open', ['-R', resolved], { timeout: 10000 });
    return { path: resolved, isDirectory: stat.isDirectory() };
  }

  // Linux: try org.freedesktop.FileManager1 first, fallback to xdg-open on parent folder
  try {
    const fileUri = pathToFileURL(resolved).href;
    await execFileAsync(
      'dbus-send',
      [
        '--session',
        '--dest=org.freedesktop.FileManager1',
        '--type=method_call',
        '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1.ShowItems',
        `array:string:${fileUri}`,
        'string:',
      ],
      { timeout: 5000 }
    );
    return { path: resolved, isDirectory: stat.isDirectory() };
  } catch {
    const fallbackDir = stat.isDirectory() ? resolved : path.dirname(resolved);
    const child = spawn('xdg-open', [fallbackDir], { detached: true, stdio: 'ignore' });
    child.unref();
    return { path: resolved, isDirectory: stat.isDirectory() };
  }
}

export async function openWithDefaultApp(targetPath) {
  const resolved = normalizeFsPath(targetPath);
  await fs.stat(resolved);

  if (process.platform === 'win32') {
    const winPath = path.win32.resolve(resolved);
    await runPowerShell('Start-Process -FilePath $env:AGY_FV_TARGET', {
      AGY_FV_TARGET: winPath,
    }, 15000);
    return { path: winPath };
  }

  if (process.platform === 'darwin') {
    await execFileAsync('open', [resolved], { timeout: 10000 });
    return { path: resolved };
  }

  const child = spawn('xdg-open', [resolved], { detached: true, stdio: 'ignore' });
  child.unref();
  return { path: resolved };
}

export async function openTerminalAt(targetPath) {
  const resolved = normalizeFsPath(targetPath);
  const stat = await fs.stat(resolved);
  const dirPath = stat.isDirectory() ? resolved : path.dirname(resolved);

  if (process.platform === 'win32') {
    const winDir = path.win32.resolve(dirPath);
    let hasWt = false;
    try {
      await execFileAsync('where.exe', ['wt.exe'], { windowsHide: true, timeout: 3000 });
      hasWt = true;
    } catch {
      hasWt = false;
    }

    if (hasWt) {
      const child = spawn('wt.exe', ['-d', winDir], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { dirPath: winDir, terminal: 'Windows Terminal' };
    }

    await runPowerShell(
      "Start-Process powershell.exe -WorkingDirectory $env:AGY_FV_DIR -ArgumentList '-NoExit'",
      { AGY_FV_DIR: winDir },
      15000
    );
    return { dirPath: winDir, terminal: 'PowerShell' };
  }

  if (process.platform === 'darwin') {
    await execFileAsync('open', ['-a', 'Terminal', dirPath], { timeout: 10000 });
    return { dirPath, terminal: 'Terminal' };
  }

  const candidates = [
    ['x-terminal-emulator', []],
    ['gnome-terminal', [`--working-directory=${dirPath}`]],
    ['konsole', ['--workdir', dirPath]],
    ['xfce4-terminal', [`--working-directory=${dirPath}`]],
  ];
  for (const [cmd, args] of candidates) {
    try {
      await execFileAsync('which', [cmd], { timeout: 2000 });
      const child = spawn(cmd, args, {
        cwd: dirPath,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { dirPath, terminal: cmd };
    } catch {
      // try next terminal
    }
  }
  throw new Error('No supported terminal emulator found');
}

export async function moveToTrash(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('At least one path is required');
  }
  const resolvedPaths = [];
  for (const p of paths) {
    const r = normalizeFsPath(p);
    await fs.stat(r);
    resolvedPaths.push(r);
  }

  if (process.platform === 'win32') {
    const winPaths = resolvedPaths.map((p) => path.win32.resolve(p));
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
$payload = $env:AGY_FV_TRASH_JSON | ConvertFrom-Json
foreach ($p in $payload.paths) {
  if (Test-Path -LiteralPath $p -PathType Container) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
  } elseif (Test-Path -LiteralPath $p -PathType Leaf) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
  } else {
    throw "Path not found: $p"
  }
}
`;
    await runPowerShell(script, {
      AGY_FV_TRASH_JSON: JSON.stringify({ paths: winPaths }),
    }, 60000);
    return { trashed: winPaths };
  }

  if (process.platform === 'darwin') {
    for (const p of resolvedPaths) {
      await execFileAsync(
        'osascript',
        ['-e', 'on run argv', '-e', 'tell application "Finder" to delete POSIX file (item 1 of argv)', '-e', 'end run', p],
        { timeout: 15000 }
      );
    }
    return { trashed: resolvedPaths };
  }

  // Linux: prefer gio trash, fallback to trash-put
  try {
    await execFileAsync('gio', ['trash', ...resolvedPaths], { timeout: 20000 });
    return { trashed: resolvedPaths };
  } catch {
    await execFileAsync('trash-put', resolvedPaths, { timeout: 20000 });
    return { trashed: resolvedPaths };
  }
}

export async function copyToOsClipboard(text) {
  if (typeof text !== 'string') {
    throw new Error('Clipboard text must be a string');
  }

  if (process.platform === 'win32') {
    await runPowerShell('Set-Clipboard -Value $env:AGY_FV_CLIP', {
      AGY_FV_CLIP: text,
    }, 10000);
    return { copied: true };
  }

  const writeStdin = (cmd, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let errText = '';
      child.stderr.on('data', (d) => { errText += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve({ copied: true });
        else reject(new Error(errText || `${cmd} exited with code ${code}`));
      });
      child.stdin.end(text, 'utf8');
    });

  if (process.platform === 'darwin') {
    return writeStdin('pbcopy', []);
  }

  const linuxTools = [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ];
  for (const [cmd, args] of linuxTools) {
    try {
      await writeStdin(cmd, args);
      return { copied: true };
    } catch {
      // try next
    }
  }
  throw new Error('No clipboard utility available');
}

export async function discoverAntigravityProjects() {
  const geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR || path.join(os.homedir(), '.gemini');
  const configRelDir = process.env.ANTIGRAVITY_CONFIG_REL_DIR || 'config';
  const projectsDir = path.join(geminiDir, configRelDir, 'projects');
  const activeProjectId = process.env.ANTIGRAVITY_PROJECT_ID || '';

  let files;
  try {
    files = await fs.readdir(projectsDir);
  } catch {
    return [];
  }

  const records = [];
  const seenPaths = new Set();

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const fullJsonPath = path.join(projectsDir, file);
    try {
      const [raw, stat] = await Promise.all([
        fs.readFile(fullJsonPath, 'utf8'),
        fs.stat(fullJsonPath),
      ]);
      const data = JSON.parse(raw);
      const resources = data?.projectResources?.resources;
      if (!Array.isArray(resources)) continue;

      for (const res of resources) {
        if (!res?.folderUri || !res.folderUri.startsWith('file://')) continue;
        let folderPath;
        try {
          folderPath = normalizeFsPath(fileURLToPath(res.folderUri));
        } catch {
          continue;
        }
        const key = process.platform === 'win32' ? folderPath.toLowerCase() : folderPath;
        if (seenPaths.has(key)) continue;

        try {
          const folderStat = await fs.stat(folderPath);
          if (!folderStat.isDirectory()) continue;
        } catch {
          continue;
        }

        seenPaths.add(key);
        records.push({
          id: data.id || path.basename(file, '.json'),
          name: data.name || path.basename(folderPath) || folderPath,
          path: folderPath,
          isActive: Boolean(activeProjectId && data.id === activeProjectId),
          mtimeMs: stat.mtimeMs,
        });
      }
    } catch {
      // skip malformed project config
    }
  }

  records.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return b.mtimeMs - a.mtimeMs;
  });

  return records.map(({ id, name, path: p, isActive }) => ({
    id,
    name,
    path: p,
    isActive,
  }));
}

export async function listDrivesAndShortcuts() {
  const home = os.homedir();
  const candidates = [
    { label: 'Home', path: home },
    { label: 'Desktop', path: path.join(home, 'Desktop') },
    { label: 'Documents', path: path.join(home, 'Documents') },
    { label: 'Downloads', path: path.join(home, 'Downloads') },
  ];

  const shortcuts = [];
  await Promise.all(
    candidates.map(async (item) => {
      try {
        const st = await fs.stat(item.path);
        if (st.isDirectory()) {
          shortcuts.push({ label: item.label, path: path.resolve(item.path) });
        }
      } catch {
        // omit absent standard directory
      }
    })
  );

  const order = new Map(candidates.map((c, idx) => [c.label, idx]));
  shortcuts.sort((a, b) => (order.get(a.label) ?? 99) - (order.get(b.label) ?? 99));

  const drives = [];
  if (process.platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    await Promise.all(
      letters.map(async (letter) => {
        const drivePath = `${letter}:\\`;
        try {
          await fs.access(drivePath);
          drives.push({ label: `${letter}:`, path: drivePath });
        } catch {
          // drive unavailable
        }
      })
    );
    drives.sort((a, b) => a.label.localeCompare(b.label));
  } else {
    drives.push({ label: '/', path: '/' });
  }

  return { shortcuts, drives };
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PATH = path.join(ROOT, 'dist', 'server.mjs');

class McpTestClient {
  constructor(serverPath, env) {
    this.proc = spawn(process.execPath, [serverPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let nlIdx;
      while ((nlIdx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nlIdx).trim();
        this.buffer = this.buffer.slice(nlIdx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`));
          } else {
            resolve(msg.result);
          }
        }
      }
    });

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => {
      this.stderr += d;
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout waiting for ${method} (stderr: ${this.stderr})`));
        }
      }, 20000);

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.proc.stdin.write(payload, 'utf8');
    });
  }

  notify(method, params = {}) {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    this.proc.stdin.write(payload, 'utf8');
  }

  async close() {
    this.proc.stdin.end();
    await new Promise((resolve) => {
      this.proc.once('close', resolve);
      setTimeout(() => {
        if (!this.proc.killed) this.proc.kill();
        resolve();
      }, 1500);
    });
  }
}

async function runTests() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-fv-测试 目录-'));
  const dataDir = path.join(tempRoot, '_plugin_data');
  const workDir = path.join(tempRoot, '工作区 space');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });

  const client = new McpTestClient(SERVER_PATH, {
    ...process.env,
    PLUGIN_ROOT: ROOT,
    PLUGIN_DATA: dataDir,
  });

  try {
    // 1. Initialize handshake
    const initRes = await client.request('initialize', {
      protocolVersion: '2025-11-21',
      capabilities: {},
      clientInfo: { name: 'test-harness', version: '1.0.0' },
    });
    assert.equal(initRes.serverInfo.name, 'agy-fileview');
    client.notify('notifications/initialized');

    // 2. Verify tools/list metadata and visibility
    const toolsRes = await client.request('tools/list');
    const byName = new Map(toolsRes.tools.map((t) => [t.name, t]));
    const openTool = byName.get('open_file_explorer');
    assert.ok(openTool, 'open_file_explorer must be registered');
    assert.equal(openTool._meta?.ui?.resourceUri, 'ui://agy-fileview/explorer.html');
    assert.deepEqual(openTool._meta?.['com.google.antigravity/ui']?.entrypoints, [
      { type: 'aux_pane', title: 'FileView' },
      { type: 'global', title: 'FileView' },
    ]);
    assert.ok(byName.has('reveal_in_explorer'), 'reveal_in_explorer must be registered');

    for (const appToolName of [
      'fv_init',
      'fv_list_dir',
      'fv_search_files',
      'fv_create_item',
      'fv_rename_item',
      'fv_copy_or_move',
      'fv_duplicate_item',
      'fv_delete_item',
      'fv_get_properties',
      'fv_read_preview',
      'fv_save_prefs',
    ]) {
      const tool = byName.get(appToolName);
      assert.ok(tool, `${appToolName} must be registered`);
      assert.deepEqual(tool._meta?.ui?.visibility, ['app'], `${appToolName} must be app-only`);
    }

    // 3. Verify UI resource
    const resList = await client.request('resources/list');
    assert.ok(
      resList.resources.some((r) => r.uri === 'ui://agy-fileview/explorer.html'),
      'UI resource must be listed'
    );
    const uiRes = await client.request('resources/read', { uri: 'ui://agy-fileview/explorer.html' });
    const htmlItem = uiRes.contents[0];
    assert.equal(htmlItem.mimeType, 'text/html;profile=mcp-app');
    assert.ok(htmlItem.text.includes('<div id="app"'), 'HTML must contain app root');
    assert.ok(Buffer.byteLength(htmlItem.text, 'utf8') < 10 * 1024 * 1024, 'HTML under 10 MiB');
    assert.ok(!/<script[^>]+src=["']https?:/i.test(htmlItem.text), 'No external script tags');
    assert.ok(!/<link[^>]+href=["']https?:/i.test(htmlItem.text), 'No external link tags');

    // 4. open_file_explorer with {} and with explicit path
    const emptyOpen = await client.request('tools/call', {
      name: 'open_file_explorer',
      arguments: {},
    });
    assert.ok(!emptyOpen.isError);
    assert.ok(emptyOpen.structuredContent.initialPath);

    const pathOpen = await client.request('tools/call', {
      name: 'open_file_explorer',
      arguments: { path: workDir },
    });
    assert.equal(pathOpen.structuredContent.initialPath, workDir);

    // 5. Create folder & file with Chinese + spaces
    const createFolder = await client.request('tools/call', {
      name: 'fv_create_item',
      arguments: { parentPath: workDir, name: '测试 目录', type: 'folder', rootPath: workDir },
    });
    assert.ok(!createFolder.isError);
    const subDir = createFolder.structuredContent.entry.path;

    const createFile = await client.request('tools/call', {
      name: 'fv_create_item',
      arguments: { parentPath: subDir, name: '示例 文件.txt', type: 'file', rootPath: workDir },
    });
    assert.ok(!createFile.isError);
    const filePath = createFile.structuredContent.entry.path;
    const sampleContent = 'Hello FileView 你好反重力\nLine 2';
    await fs.writeFile(filePath, sampleContent, 'utf8');

    // Reject dangerous/invalid names
    for (const badName of ['../escape', 'a/b', 'a\\b', 'bad:name', '']) {
      const badRes = await client.request('tools/call', {
        name: 'fv_create_item',
        arguments: { parentPath: workDir, name: badName, type: 'file' },
      });
      assert.equal(badRes.isError, true, `Expected error for invalid name "${badName}"`);
    }

    // 6. List dir & search files
    const listRes = await client.request('tools/call', {
      name: 'fv_list_dir',
      arguments: { path: subDir, rootPath: workDir },
    });
    assert.equal(listRes.structuredContent.entries.length, 1);
    assert.equal(listRes.structuredContent.entries[0].relativePath, path.join('测试 目录', '示例 文件.txt'));

    const searchRes = await client.request('tools/call', {
      name: 'fv_search_files',
      arguments: { rootPath: workDir, query: '示例' },
    });
    assert.equal(searchRes.structuredContent.results.length, 1);

    // 7. Properties + SHA-256 + Preview
    const expectedHash = crypto.createHash('sha256').update(sampleContent, 'utf8').digest('hex');
    const propsRes = await client.request('tools/call', {
      name: 'fv_get_properties',
      arguments: { path: filePath, computeHash: true },
    });
    assert.equal(propsRes.structuredContent.sha256, expectedHash);

    const previewRes = await client.request('tools/call', {
      name: 'fv_read_preview',
      arguments: { path: filePath },
    });
    assert.equal(previewRes.structuredContent.text, sampleContent);
    assert.equal(previewRes.structuredContent.isBinary, false);

    // 8. Duplicate, rename, copy, move
    const dupRes = await client.request('tools/call', {
      name: 'fv_duplicate_item',
      arguments: { path: filePath, rootPath: workDir },
    });
    assert.equal(dupRes.structuredContent.entry.name, '示例 文件 - Copy.txt');

    const renameRes = await client.request('tools/call', {
      name: 'fv_rename_item',
      arguments: { path: dupRes.structuredContent.entry.path, newName: '改名 文件.txt', rootPath: workDir },
    });
    const renamedPath = renameRes.structuredContent.entry.path;
    assert.equal(renameRes.structuredContent.entry.name, '改名 文件.txt');

    // Prevent copying folder into itself
    const selfCopyErr = await client.request('tools/call', {
      name: 'fv_copy_or_move',
      arguments: { sources: [subDir], targetDir: subDir, mode: 'copy' },
    });
    assert.equal(selfCopyErr.isError, true);

    const moveRes = await client.request('tools/call', {
      name: 'fv_copy_or_move',
      arguments: { sources: [renamedPath], targetDir: workDir, mode: 'move', rootPath: workDir },
    });
    assert.ok(!moveRes.isError);
    const movedPath = moveRes.structuredContent.entries[0].path;
    assert.equal(path.dirname(movedPath), workDir);

    // 9. Preferences persistence
    const prefsRes = await client.request('tools/call', {
      name: 'fv_save_prefs',
      arguments: { lastPath: workDir, showHidden: true, pinnedFolders: [subDir], lang: 'en' },
    });
    assert.equal(prefsRes.structuredContent.preferences.showHidden, true);
    assert.equal(prefsRes.structuredContent.preferences.lang, 'en');

    // 10. Delete (permanent and Recycle Bin)
    const permDel = await client.request('tools/call', {
      name: 'fv_delete_item',
      arguments: { paths: [movedPath], permanent: true },
    });
    assert.equal(permDel.structuredContent.permanent, true);
    await assert.rejects(() => fs.stat(movedPath));

    const trashTarget = path.join(workDir, 'recycle-测试 文件.txt');
    await fs.writeFile(trashTarget, 'trash me', 'utf8');
    const trashDel = await client.request('tools/call', {
      name: 'fv_delete_item',
      arguments: { paths: [trashTarget], permanent: false },
    });
    assert.equal(trashDel.structuredContent.permanent, false);
    await assert.rejects(() => fs.stat(trashTarget));

    console.log('[test] All MCP server, UI resource, and file operation tests passed!');
  } finally {
    await client.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error('[test] Failed:', err);
  process.exit(1);
});

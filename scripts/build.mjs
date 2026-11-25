import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(ROOT, 'dist');

async function build() {
  await fs.mkdir(DIST_DIR, { recursive: true });

  // 1. Bundle MCP server into a zero-dependency single ESM file
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'server.mjs')],
    outfile: path.join(DIST_DIR, 'server.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    minify: false,
    sourcemap: false,
    banner: {
      js: "import { createRequire as __fvCreateRequire } from 'node:module'; const require = __fvCreateRequire(import.meta.url);",
    },
  });

  // 2. Bundle browser UI script in-memory
  const uiResult = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'ui', 'app.ts')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: true,
    sourcemap: false,
  });

  const jsCode = uiResult.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const cssCode = await fs.readFile(path.join(ROOT, 'src', 'ui', 'styles.css'), 'utf8');
  const template = await fs.readFile(path.join(ROOT, 'src', 'ui', 'index.html'), 'utf8');

  const html = template
    .replace('/* __INLINE_CSS__ */', () => cssCode)
    .replace('/* __INLINE_JS__ */', () => jsCode);

  const htmlOutPath = path.join(DIST_DIR, 'app.html');
  await fs.writeFile(htmlOutPath, html, 'utf8');

  const [serverStat, htmlStat] = await Promise.all([
    fs.stat(path.join(DIST_DIR, 'server.mjs')),
    fs.stat(htmlOutPath),
  ]);

  console.log(
    `[build] dist/server.mjs: ${(serverStat.size / 1024).toFixed(1)} KB, dist/app.html: ${(htmlStat.size / 1024).toFixed(1)} KB`
  );
}

build().catch((err) => {
  console.error('[build] Failed:', err);
  process.exit(1);
});

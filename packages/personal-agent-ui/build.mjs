import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const localRequire = createRequire(import.meta.url);
let esbuild;
try { esbuild = localRequire('esbuild'); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  // The repository's existing tsx installation pins the same build engine.
  esbuild = createRequire(localRequire.resolve('tsx'))('esbuild');
}
const root = fileURLToPath(new URL('.', import.meta.url));
const runtime = fileURLToPath(new URL('../harness-dsh/.runtime/node_modules', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));
await mkdir(new URL('dist/', import.meta.url), { recursive: true });
await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['client.tsx'],
  outfile: 'dist/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome120', 'safari17'],
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-primitives'],
  nodePaths: [runtime],
  loader: { '.css': 'text' },
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
  footer: { js: 'return module.exports;}});' },
  metafile: true,
  logLevel: 'info',
});

import { readFile, writeFile } from 'node:fs/promises';
const here = new URL('.', import.meta.url);
const files = ['page-diff.mjs', 'watch.mjs', 'scenarios.mjs', 'demo.mjs'];
const source = (await Promise.all(files.map(name => readFile(new URL(name, here), 'utf8'))))
  .map(text => text.replace(/^import .*?;\n/gmu, '').replace(/^export /gmu, ''))
  .join('\n\n').replace(/<\/script/giu, '<\\/script');
const template = await readFile(new URL('demo.template.html', here), 'utf8');
if (template.split('/* MODULE_BUNDLE */').length !== 2) throw new Error('Expected one bundle slot');
// No dependencies, server or network request. The checked-in source remains editable.
await writeFile(new URL('demo.html', here), template.replace('/* MODULE_BUNDLE */', () => source));
console.log('Built self-contained demo.html');

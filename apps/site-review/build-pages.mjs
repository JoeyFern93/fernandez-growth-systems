import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {extensionZip} from './extension-zip.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, 'dist');
await mkdir(output, {recursive:true});
await cp(path.join(root,'public'), output, {recursive:true});
const downloads = path.join(output, 'downloads');
await mkdir(downloads, {recursive:true});
await writeFile(path.join(downloads, 'fgs-site-review.zip'), await extensionZip(path.join(root, 'extension')));

// Pages can start serving a new HTML document while a browser still has
// the previous script cached. Keep each UI version paired with its markup.
const documents = new Map();
for (const name of ['index.html', 'chrome/index.html']) {
  documents.set(name, await readFile(path.join(output, name), 'utf8'));
}
for (const asset of ['review.js','review.css','install.js','install.css','companion.js','chrome-desktop.js','chrome/guide.css','annotation-preview.js','visual-marks.js']) {
  const bytes = await readFile(path.join(root,'public',asset));
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0,12);
  const ext = path.extname(asset);
  const versioned = asset.slice(0,-ext.length) + '.' + digest + ext;
  await writeFile(path.join(output,versioned),bytes);
  for (const [name, html] of documents) {
    documents.set(name, html.replace('"/' + asset + '"','"/' + versioned + '"'));
  }
}
for (const [name, html] of documents) await writeFile(path.join(output, name), html);

// Pages advanced mode serves one worker. Inline the small local modules in their own scopes.
const replayPreview = process.env.CF_PAGES_BRANCH === 'qa/replay-audit-fixes-20261124';
const entry = replayPreview ? 'replay-preview-worker.js' : 'worker.js';
let bundle = await readFile(path.join(root,entry),'utf8');
const imports = [...bundle.matchAll(/^import \{([^}]+)\} from ["']\.\/([\w-]+\.js)["'];?$/gm)];
for (const [declaration, names, filename] of imports) {
  const source = await readFile(path.join(root,filename),'utf8');
  if (/^import /m.test(source)) throw new Error('Nested module imports need bundling in ' + filename);
  const definitions = source.replace(/^export default \w+;?\s*$/gm,'').replace(/^export /gm,'');
  bundle = bundle.replace(declaration, () => 'const {' + names + '} = (() => {\n' + definitions + '\nreturn {' + names + '};\n})();');
}
if (/^import /m.test(bundle)) throw new Error('A worker import was not bundled.');
if (replayPreview) {
  // The QA alias and its immutable deployment must never fall through to Site Review.
  await writeFile(path.join(output,'_routes.json'),JSON.stringify({version:1,include:['/*'],exclude:[]}));
}
await writeFile(path.join(output,'_worker.js'),bundle);
console.log('Built Site Review for Cloudflare Pages.');

import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, 'dist');
await mkdir(output, {recursive:true});
await cp(path.join(root,'public'), output, {recursive:true});

// Pages can start serving a new HTML document while a browser still has
// the previous script cached. Keep each UI version paired with its markup.
let html = await readFile(path.join(output,'index.html'),'utf8');
for (const asset of ['review.js','review.css','install.js','install.css','companion.js']) {
  const bytes = await readFile(path.join(root,'public',asset));
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0,12);
  const ext = path.extname(asset);
  const versioned = path.basename(asset,ext) + '.' + digest + ext;
  await writeFile(path.join(output,versioned),bytes);
  html = html.replace('"/' + asset + '"','"/' + versioned + '"');
}
await writeFile(path.join(output,'index.html'),html);

// Bundle our two dependency-free modules for Pages' single-file advanced mode.
const capture = await readFile(path.join(root,'capture.js'),'utf8');
const worker = await readFile(path.join(root,'worker.js'),'utf8');
const captureImport = /^import\s*\{([^}]+)\}\s*from\s*["']\.\/capture\.js["'];?/m;
const imported = worker.match(captureImport);
if (!imported) throw new Error('The capture module import is missing.');
const functions = imported[1].trim();
const bundledCapture = 'const { ' + functions + ' } = (() => {\n' +
  capture.replace(/^export default captureWorker;?\s*$/gm,'').replace(/^export /gm,'') +
  '\nreturn { ' + functions + ' };\n})();';
const bundle = worker.replace(captureImport, () => bundledCapture);
await writeFile(path.join(output,'_worker.js'),bundle);
console.log('Built Site Review for Cloudflare Pages.');

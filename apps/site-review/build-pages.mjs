import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, 'dist');
await mkdir(output, {recursive:true});
await cp(path.join(root,'public'), output, {recursive:true});

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

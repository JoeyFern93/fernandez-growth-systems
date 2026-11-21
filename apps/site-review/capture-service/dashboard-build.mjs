import {readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

// Wrangler bundles the normal two-module entry automatically. The dashboard
// editor takes a single ES module with the same native Worker entrypoint.
const output = process.argv[2] || path.join(tmpdir(), "fgs-site-review-private-worker.mjs");
const [capture, entry] = await Promise.all([
  readFile(new URL("../capture.js", import.meta.url), "utf8"),
  readFile(new URL("worker.js", import.meta.url), "utf8")
]);
const module = capture.replace(/^export default captureWorker;\s*$/m, "").replace(/^export /gm, "");
const source = entry.replace(/^import captureWorker, \{ renderViaCallback \} from "\.\.\/capture\.js";$/m, () => module);
await writeFile(output, source);
console.log(output);

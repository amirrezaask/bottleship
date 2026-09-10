/** Node + Chromium CPU benchmarks; no emulator session, GPU timing, or native driver claim. */
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir, cpus } from 'node:os';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ts = (await import(process.env.TYPESCRIPT_MODULE || 'typescript')).default;
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const base = process.argv[2] || 'a7c8543d75569d48890d48744897a0ffe3fb02f7';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const virtual = new Map(['dxt', 'dx-sampler'].map(name => [
  `/src/worker/backends/webgpu/shared/.perf-base-${name}.ts`,
  git('show', `${base}:src/worker/backends/webgpu/shared/${name}.ts`),
]));
let resolveResult;
const completed = new Promise(resolve => { resolveResult = resolve; });
const page = `<!doctype html><meta charset="utf-8"><pre id="result"></pre><script>
window.report = result => fetch('/result', {method: 'POST', body: JSON.stringify(result)});
window.addEventListener('error', e => window.report({error: e.message}));
window.addEventListener('unhandledrejection', e => window.report({error: String(e.reason)}));
</script><script type="module">
import * as beforeDxt from '/src/worker/backends/webgpu/shared/.perf-base-dxt.ts';
import * as beforeSampler from '/src/worker/backends/webgpu/shared/.perf-base-dx-sampler.ts';
import { initializeDxtKernel } from '/src/worker/backends/webgpu/shared/dxt-kernel';
import { benchmarkFastpaths } from '/tools/perf/fastpaths-workloads';
try {
  if (!await initializeDxtKernel()) throw new Error('WASM initialization failed');
  const results = benchmarkFastpaths(beforeDxt, beforeSampler);
  await window.report({ userAgent: navigator.userAgent, results });
} catch (error) { await window.report({ error: String(error), stack: error.stack }); }
</script>`;
const server = createServer(async (req, res) => {
  try {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (path === '/result' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) throw new Error('Report too large'); }
      resolveResult(JSON.parse(body)); res.end('ok'); return;
    }
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(page); return; }
    let target = resolve(root, '.' + path);
    if (!target.startsWith(root.replace(/\/$/, '') + sep)) { res.writeHead(403); res.end(); return; }
    if (!extname(target)) target += '.ts';
    const source = virtual.get(path) ?? await readFile(target);
    if (target.endsWith('.ts')) {
      const { outputText } = ts.transpileModule(source.toString(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
      res.setHeader('Content-Type', 'text/javascript'); res.end(outputText);
    } else { res.setHeader('Content-Type', target.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'); res.end(source); }
  } catch (error) { res.writeHead(404); res.end(String(error)); }
});
const profile = await mkdtemp(resolve(tmpdir(), 'bottleship-perf-'));
let child;
let timer;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let chrome = process.env.CHROME_BIN;
  if (!chrome) for (const candidate of ['google-chrome', 'chromium', 'chromium-browser']) {
    try { execFileSync(candidate, ['--version'], { stdio: 'ignore' }); chrome = candidate; break; } catch { /* Try next installed binary. */ }
  }
  if (!chrome) throw new Error('Chromium not found; set CHROME_BIN');
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-dev-shm-usage', '--disable-background-timer-throttling',
    `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}/`];
  // Root containers cannot start Chrome's sandbox; this is a local CPU benchmark only.
  if (process.getuid?.() === 0) args.unshift('--no-sandbox');
  let stderr = '';
  child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
  const result = await Promise.race([
    completed,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Chromium benchmark timed out: ${stderr}`)), 45000); }),
    new Promise((_, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error(`Chrome exited ${code}: ${stderr}`))); }),
  ]);
  if (result.error) throw new Error(JSON.stringify(result));
  const report = { baseline: git('rev-parse', base), candidate: git('rev-parse', 'HEAD'), dirty: !!git('status', '--porcelain', '--untracked-files=no'),
    cpu: cpus()[0]?.model, note: 'Chromium CPU microbenchmarks; both WASM copies included; no GPU or game-FPS claim.', ...result };
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(report, null, 2) + '\n');
  console.table(result.results.map(({ case: name, beforeMs, afterMs, speedup }) => ({ case: name, beforeMs, afterMs, speedup })));
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearTimeout(timer);
  if (child && child.exitCode === null) {
    const stopped = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await stopped;
  }
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = `${root}src/worker/backends/webgpu/shared/dxt-kernel.wasm`;
mkdirSync(`${root}src/worker/backends/webgpu/shared`, { recursive: true });
execFileSync('rustc', [
  '+1.85.0', '--edition=2021', '--crate-type=cdylib',
  '--target=wasm32-unknown-unknown', '-C', 'opt-level=3',
  '-C', 'panic=abort', '-C', 'lto=fat', '-C', 'codegen-units=1',
  '-C', 'strip=symbols', '-C', 'link-arg=--export=__heap_base',
  '-C', 'link-arg=--max-memory=67108864',
  `${root}tools/build-dxt-kernel/lib.rs`, '-o', output,
], { stdio: 'inherit' });
console.log(output);

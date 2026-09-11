import { execFileSync } from 'node:child_process';
import { mkdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = `${root}src/worker/backends/webgpu/shared`;
mkdirSync(directory, { recursive: true });
for (const simd of [false, true]) {
  const output = `${directory}/dxt-kernel${simd ? '-simd' : ''}.wasm`;
  execFileSync('rustc', [
    '+1.85.0', '--edition=2021', '--crate-type=cdylib',
    '--target=wasm32-unknown-unknown', '-C', 'opt-level=3',
    '-C', 'panic=abort', '-C', 'lto=fat', '-C', 'codegen-units=1',
    '-C', `target-feature=${simd ? '+' : '-'}simd128`,
    '-C', 'strip=symbols', '-C', 'link-arg=--export=__heap_base',
    '-C', 'link-arg=--max-memory=67108864',
    `${root}tools/build-dxt-kernel/lib.rs`, '-o', output,
  ], { stdio: 'inherit' });
  chmodSync(output, 0o644);
  console.log(output);
}

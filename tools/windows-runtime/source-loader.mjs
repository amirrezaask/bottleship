/** Isolated HLE tests: execute the actual TS sources, not a copied implementation.
 * CPU scheduling, logging and GPU I/O are outside these kernel measurements.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, relative } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

export async function loadSources({ root = process.cwd(), ref, sources = {}, tracking = false } = {}) {
    if (!vm.SourceTextModule) throw new Error('Run Node with --experimental-vm-modules');
    const counts = { DataView: 0, ArrayBuffer: 0, Float32Array: 0, Float64Array: 0 };
    const faults = [];
    const context = vm.createContext({
        console, Uint8Array, Uint32Array, Int32Array, SharedArrayBuffer, WebAssembly,
        DataView, ArrayBuffer, Float32Array, Float64Array, Math,
    });
    if (tracking) for (const name of Object.keys(counts)) {
        context[name] = new Proxy(globalThis[name], {
            construct(target, args) { counts[name]++; return Reflect.construct(target, args); },
        });
    }
    const mocks = {
        'src/worker/core/logger.ts': { Logger: { error() {}, warn() {}, log() {}, verbose() {} }, LogCategory: { SYSTEM: 'SYSTEM' } },
        'src/worker/core/memory/memory-fault.ts': { reportMemoryFault: fault => faults.push(fault), MemoryAccessType: undefined },
        'src/worker/core/system.ts': { System: {} },
        'src/worker/core/thunking/thunk-dispatcher.ts': { ThunkImplementation: undefined },
        'src/worker/core/module.ts': { IModule: undefined },
        'src/worker/core/process.ts': { Process: undefined },
        'src/worker/api/types.ts': { ModuleDescriptor: undefined, FunctionDescriptor: undefined, ParameterDescriptor: undefined },
        // The registration test retains the real D3dx9 class; unrelated GPU factories
        // are isolated. This is deliberately NOT an emulator/gameplay test.
        'src/worker/modules/d3dx9/surfaces.ts': { createSurfaceExports: () => ({}) },
        'src/worker/modules/d3dx9/textures.ts': { createTextureExports: () => ({}) },
        'src/worker/modules/d3dx9/effects.ts': { createEffectExports: () => ({}), resetEffectState() {} },
    };
    const cache = new Map();
    const read = path => sources[path] ?? (ref
        ? execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8' })
        : readFileSync(resolve(root, path), 'utf8'));
    const get = async path => {
        if (cache.has(path)) return cache.get(path);
        let mod;
        if (mocks[path]) {
            const values = mocks[path];
            mod = new vm.SyntheticModule(Object.keys(values), function () {
                for (const [name, value] of Object.entries(values)) this.setExport(name, value);
            }, { context, identifier: path });
        } else {
            mod = new vm.SourceTextModule(stripTypeScriptTypes(read(path), { mode: 'transform' }), { context, identifier: path });
        }
        cache.set(path, mod);
        await mod.link((specifier, from) => {
            if (!specifier.startsWith('.')) throw new Error(`Unisolated dependency ${specifier} in ${from.identifier}`);
            const filename = relative(root, resolve(root, dirname(from.identifier), specifier)).replaceAll('\\', '/');
            return get(filename.endsWith('.ts') ? filename : `${filename}.ts`);
        });
        return mod;
    };
    return {
        counts, faults,
        resetCounts() { for (const key of Object.keys(counts)) counts[key] = 0; },
        async load(path) {
            const mod = await get(path);
            if (mod.status !== 'evaluated') await mod.evaluate();
            return mod.namespace;
        },
    };
}

export async function loadMath(options) {
    const loader = await loadSources(options);
    const { Mem } = await loader.load('src/worker/core/memory/mem-accessor.ts');
    const { createMathExports, u32AsFloat } = await loader.load('src/worker/modules/d3dx9/math.ts');
    return { ...loader, Mem, functions: createMathExports(), u32AsFloat };
}

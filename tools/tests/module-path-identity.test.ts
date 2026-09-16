import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, type LoadedPEModule } from '../../src/worker/core/module-registry';

function dll(name: string, baseAddress = 0x13000000): LoadedPEModule {
    return { name, path: `${name}.dll`, baseAddress, size: 0x10000, entryPoint: 0,
        exports: new Map([['controls', baseAddress + 0x1000]]), ordinalExports: new Map(),
        isRealDll: true, initialized: true };
}

describe('loaded DLL identity', () => {
    test('an import by basename reuses a DLL loaded by full path', () => {
        const registry = new ModuleRegistry();
        const entities = dll('C:\\Bin\\Entities');
        registry.register(entities);
        expect(registry.getByName('Entities.dll')).toBe(entities);
        expect(registry.getByName('ENTITIES')).toBe(entities);
        expect(registry.getByName('c:/bin/entities.dll')).toBe(entities);
        expect(registry.getByBase(entities.baseAddress)).toBe(entities);
    });
    test('explicit paths keep distinct DLL images with the same filename', () => {
        const registry = new ModuleRegistry();
        const first = dll('C:\\One\\Entities');
        const second = dll('C:\\Two\\Entities', 0x14000000);
        registry.register(first);
        registry.register(second);
        expect(registry.getByName('C:/Two/Entities.dll')).toBe(second);
        expect(registry.getByName('Entities.dll')).toBe(first);
        expect(registry.getByName('C:/Three/Entities.dll')).toBeUndefined();
        registry.unregister('C:/One/Entities.dll');
        expect(registry.getByName('Entities.dll')).toBe(second);
    });
    test('a DLL import never reuses the same-named executable', () => {
        const registry = new ModuleRegistry();
        registry.register({ ...dll('C:\\Game\\hl'), isExecutable: true });
        expect(registry.getByName('hl.dll')).toBeUndefined();
    });
});

import { ModuleDescriptor } from './types';

/**
 * EBUEula.dll ships with Midtown Madness 2's retail wrapper. The game invokes
 * its sole export dynamically as a cdecl function with four pointer/integer
 * arguments and treats a non-zero result as acceptance.
 */
export const ebueulaModule: ModuleDescriptor = {
    name: 'ebueula',
    functions: [{
        name: 'EBUEula',
        params: [
            { name: 'hInstance', type: 'u32' },
            { name: 'hWnd', type: 'u32' },
            { name: 'product', type: 'u32' },
            { name: 'flags', type: 'u32' },
        ],
        returnType: 'u32',
        callingConvention: 'cdecl',
    }],
};

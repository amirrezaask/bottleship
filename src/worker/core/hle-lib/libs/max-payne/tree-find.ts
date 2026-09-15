import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';
import { HANDLER_MAX_PAYNE_TREE_FIND } from '../../../cpu/hypercall-ids';
import { libHleManager, recordHleHit } from '../../lib-hle-manager';
import type { LibDescriptor } from '../../types';

const LIB_ID = 'max-payne';
const FUNCTION_NAME = 'ordered_tree_find';

/**
 * MaxPayne.exe v2, RVA 0x13cbf0. This is the complete 42-byte ordered-tree
 * lookup loop through its terminating branch. The absolute sentinel operand
 * deliberately makes the match fixed-image/exact-build rather than generic.
 */
export const MAX_PAYNE_TREE_FIND_PATTERN = new Uint8Array([
    0x8b, 0x41, 0x04, 0x8b, 0x48, 0x04, 0x8b, 0x15, 0xcc, 0xe3, 0x8a, 0x00,
    0x3b, 0xca, 0x74, 0x1a, 0x56, 0x8b, 0x74, 0x24, 0x08, 0x8b, 0x36, 0x39,
    0x71, 0x0c, 0x7d, 0x05, 0x8b, 0x49, 0x08, 0xeb, 0x04, 0x8b, 0xc1, 0x8b,
    0x09, 0x3b, 0xca, 0x75, 0xee, 0x5e,
]);

const fallback: ThunkImplementation = (_ctx, _memory, args) => {
    recordHleHit(LIB_ID, FUNCTION_NAME);
    const result = libHleManager.callOriginalSync(LIB_ID, FUNCTION_NAME, args, 'stdcall');
    return result.ok ? result.eax : 0;
};

export const maxPayneDescriptor: LibDescriptor = {
    id: LIB_ID,
    displayName: 'Max Payne 1 ordered-tree lookup',
    minConfidence: 12,
    signatures: {
        ordered_tree_find: {
            kind: 'bytes',
            pattern: MAX_PAYNE_TREE_FIND_PATTERN,
            mask: 'x'.repeat(MAX_PAYNE_TREE_FIND_PATTERN.length),
            section: '.text',
            weight: 12,
        },
    },
    functions: {
        ordered_tree_find: {
            name: FUNCTION_NAME,
            entryProbe: {
                kind: 'prologue',
                pattern: MAX_PAYNE_TREE_FIND_PATTERN,
                mask: 'x'.repeat(MAX_PAYNE_TREE_FIND_PATTERN.length),
                section: '.text',
            },
            // The original is __thiscall with ECX preserved by the generic
            // stub and one callee-popped stack argument (`ret 4`).
            callingConvention: 'stdcall',
            argCount: 1,
            required: true,
            // mov eax,[ecx+4]; mov ecx,[eax+4] — two complete,
            // position-independent instructions for the fallback trampoline.
            prologueLen: 6,
            hypercallHandlerId: HANDLER_MAX_PAYNE_TREE_FIND,
        },
    },
    handlers: { ordered_tree_find: fallback },
};

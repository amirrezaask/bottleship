/**
 * Resolve the live v86 objects used by profile-plan discovery.
 *
 * V86Starter exposes a compatibility-shaped `cpu`/`mem8` surface in some
 * builds. The worker's canonical CPU accessor prefers V86Starter.cpu and then
 * falls back to the nested core. Process.getCurrentMemory() is the canonical
 * BottleShip memory accessor and must win over either compatibility surface so
 * page-table reads observe the same bytes as the guest runtime.
 */
export interface ProfilePlanRuntime {
    cpu: any;
    memory: Uint8Array;
}

const MIN_GUEST_MEMORY_BYTES = 16 * 1024 * 1024;
const MAX_GUEST_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;

function isBoundedByteView(value: unknown): value is Uint8Array {
    if (!value || typeof value !== 'object' || value instanceof DataView) return false;
    const view = value as {
        BYTES_PER_ELEMENT?: number;
        buffer?: ArrayBufferLike;
        byteOffset?: number;
        length?: number;
        subarray?: unknown;
    };
    const length = view.length;
    const offset = view.byteOffset;
    return view.BYTES_PER_ELEMENT === 1 &&
        Number.isSafeInteger(length) &&
        Number.isSafeInteger(offset) &&
        (offset as number) >= 0 &&
        (length as number) >= MIN_GUEST_MEMORY_BYTES &&
        (length as number) <= MAX_GUEST_MEMORY_BYTES &&
        (length as number) % 4096 === 0 &&
        typeof view.subarray === 'function' &&
        !!view.buffer &&
        (offset as number) + (length as number) <= view.buffer.byteLength;
}

export function resolveProfilePlanRuntime(process: any): ProfilePlanRuntime {
    if (!process) throw new Error('Profile plan requires a live process');

    const v86 = process.v86;
    const cpu = v86?.cpu ?? v86?.v86?.cpu;
    let memory: unknown;
    try {
        memory = process.getCurrentMemory?.();
    } catch {
        memory = undefined;
    }
    memory ??= v86?.mem8 ?? v86?.v86?.cpu?.mem8;
    // ArrayBuffer.isView is realm-safe; `instanceof Uint8Array` is not when the
    // V86 compatibility surface originates in a different JavaScript realm.
    if (!isBoundedByteView(memory)) {
        const candidate = memory as { length?: unknown; BYTES_PER_ELEMENT?: unknown } | undefined;
        const length = typeof candidate?.length === 'number' ? candidate.length : -1;
        const elementBytes = typeof candidate?.BYTES_PER_ELEMENT === 'number' ? candidate.BYTES_PER_ELEMENT : -1;
        throw new Error(
            `Profile plan requires bounded guest memory (type=${typeof memory}, length=${length}, elementBytes=${elementBytes})`,
        );
    }
    if (!cpu) throw new Error('Profile plan requires a live CPU');
    return { cpu, memory };
}

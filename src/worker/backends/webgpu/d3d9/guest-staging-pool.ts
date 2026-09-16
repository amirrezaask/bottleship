/** Bounded scratch for D3D9 geometry locks. Persistent pixels/vertices still live
 * in their stores; only the temporary, guest-addressable lock buffer is reused. */
export interface GuestStagingAllocator {
    alloc(bytes: number, type: "HEAP"): number;
    free(pointer: number): unknown;
}

export class GuestStagingPool {
    static readonly MAX_IDLE_BYTES = 4 * 1024 * 1024;
    static readonly MAX_POOLED_ALLOCATION = 1024 * 1024;
    private idle = new Map<number, number[]>();
    private active = new Map<number, number>();
    private idleBytes = 0;
    private activeBytes = 0;
    private peakBytes = 0;
    private allocations = 0;
    private reuses = 0;

    constructor(private readonly allocator: GuestStagingAllocator) {}

    acquire(bytes: number): number {
        if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("Invalid geometry staging size");
        const capacity = bytes <= GuestStagingPool.MAX_POOLED_ALLOCATION
            ? 2 ** Math.ceil(Math.log2(Math.max(4096, bytes))) : bytes;
        const bucket = this.idle.get(capacity);
        let pointer = bucket?.pop();
        if (pointer !== undefined) {
            this.idleBytes -= capacity;
            this.reuses = Math.min(Number.MAX_SAFE_INTEGER, this.reuses + 1);
        } else {
            pointer = this.allocator.alloc(capacity, "HEAP");
            if (!pointer) return 0;
            this.allocations = Math.min(Number.MAX_SAFE_INTEGER, this.allocations + 1);
        }
        this.active.set(pointer, capacity);
        this.activeBytes += capacity;
        this.peakBytes = Math.max(this.peakBytes, this.activeBytes + this.idleBytes);
        return pointer;
    }

    release(pointer: number): void {
        const capacity = this.active.get(pointer);
        if (capacity === undefined) return;
        this.active.delete(pointer);
        this.activeBytes -= capacity;
        const bucket = this.idle.get(capacity);
        if (capacity <= GuestStagingPool.MAX_POOLED_ALLOCATION
            && this.idleBytes + capacity <= GuestStagingPool.MAX_IDLE_BYTES
            && (bucket?.length ?? 0) < 4) {
            if (bucket) bucket.push(pointer);
            else this.idle.set(capacity, [pointer]);
            this.idleBytes += capacity;
        } else {
            this.allocator.free(pointer);
        }
    }

    getStats() {
        return { idleBytes: this.idleBytes, activeBytes: this.activeBytes, peakBytes: this.peakBytes,
            allocations: this.allocations, reuses: this.reuses };
    }

    resetStats(): void {
        this.allocations = 0; this.reuses = 0;
        this.peakBytes = this.activeBytes + this.idleBytes;
    }

    /** Device teardown also owns buffers still locked by the terminated guest. */
    dispose(): void {
        for (const pointers of this.idle.values()) for (const pointer of pointers) this.allocator.free(pointer);
        for (const pointer of this.active.keys()) this.allocator.free(pointer);
        this.idle.clear(); this.active.clear();
        this.idleBytes = 0; this.activeBytes = 0;
    }
}

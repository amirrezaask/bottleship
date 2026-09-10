import { test } from "bun:test";
import assert from "node:assert/strict";
import { toPlainGuestMemory, borrowGuestMemory, setGuestMemoryStaleGuard } from "../../src/worker/core/memory/guest-memory";

// v86 re-resolves the view after growth and binds function-valued properties.
function proxyView(current: () => Uint8Array): Uint8Array {
    return new Proxy(new Uint8Array(0), {
        get(_target, prop) {
            assert.notEqual(prop, "byteLength", "v86 does not whitelist byteLength");
            const view = current();
            const value = Reflect.get(view, prop, view);
            return typeof value === "function" ? value.bind(view) : value;
        },
    });
}

test("normalization distinguishes subviews sharing a buffer without copying", () => {
    const bytes = new Uint8Array(64);
    const a = proxyView(() => bytes.subarray(4, 12));
    const b = proxyView(() => bytes.subarray(20, 32));
    const first = toPlainGuestMemory(a);
    assert.strictEqual(toPlainGuestMemory(a), first);
    const second = toPlainGuestMemory(b);
    assert.equal(second.byteOffset, 20);
    assert.equal(second.length, 12);
    assert.notStrictEqual(second, first);
    second[0] = 173;
    assert.equal(bytes[20], 173);
    assert.equal(bytes[4], 0);
    assert.strictEqual(toPlainGuestMemory(bytes), bytes);
    assert.equal(toPlainGuestMemory(null), null);
});

test("normalization refreshes after real WebAssembly memory growth", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const proxy = proxyView(() => new Uint8Array(memory.buffer));
    const before = toPlainGuestMemory(proxy);
    memory.grow(1);
    const after = toPlainGuestMemory(proxy);
    assert.notStrictEqual(before.buffer, after.buffer);
    assert.equal(after.length, 131072);
    after[100000] = 47;
    assert.equal(new Uint8Array(memory.buffer)[100000], 47);
});

test("diagnostic guard preserves typed-array accessors and detects stale reads", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const proxy = proxyView(() => new Uint8Array(memory.buffer));
    setGuestMemoryStaleGuard(true);
    try {
        const guarded = borrowGuestMemory(proxy);
        assert.equal(guarded.length, 65536);
        assert.equal(guarded.byteLength, 65536);
        assert.strictEqual(guarded.buffer, memory.buffer);
        guarded[7] = 18;
        assert.equal(guarded.subarray(7, 8)[0], 18);
        memory.grow(1);
        toPlainGuestMemory(proxy);
        assert.throws(() => guarded[7], /STALE/);
        assert.throws(() => { guarded[7] = 42; }, /STALE/);
        assert.equal(borrowGuestMemory(proxy)[7], 18);
    } finally { setGuestMemoryStaleGuard(false); }
});

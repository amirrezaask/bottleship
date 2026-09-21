import { describe, expect, test } from "bun:test";
import { MemoryEventBuffer, MemoryEventType } from "../../src/worker/core/memory/memory-event-buffer";

function event(timestamp: number, address: number) {
    return {
        timestamp,
        type: MemoryEventType.LOCK,
        address,
        size: 16,
    };
}

describe("memory event diagnostics", () => {
    test("returns only initialized events before the ring wraps", () => {
        const buffer = new MemoryEventBuffer();
        buffer.record(event(10, 0x1000));
        buffer.record(event(20, 0x2000));

        expect(buffer.getRecent(20)).toEqual([
            event(10, 0x1000),
            event(20, 0x2000),
        ]);
    });

    test("keeps chronological order after the ring wraps", () => {
        const buffer = new MemoryEventBuffer();
        for (let i = 0; i < 4100; i++) buffer.record(event(i, i));

        const recent = buffer.getRecent(3);
        expect(recent.map((item) => item.timestamp)).toEqual([4097, 4098, 4099]);
    });
});

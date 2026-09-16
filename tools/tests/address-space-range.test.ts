import { expect, test } from 'bun:test';
import { AddressSpace } from '../../src/worker/core/memory/address-space';

test('range rejection preserves registration, protection, overlap order, release and reset', () => {
    const space = new AddressSpace(() => new Uint8Array(0x400000));
    expect(space.validateRange(0xff000000, 4)).toBe(false);
    space.registerRegion({base: 0x200000, size: 0x1000, perms: 'r', kind: 'HEAP', allowOverlap: true});
    space.registerRegion({base: 0x200000, size: 0x1000, perms: 'rw', kind: 'HEAP', allowOverlap: true});
    expect(space.validateRange(0x200000, 4)).toBe(false); // first match remains authoritative
    expect(space.protect(0x200000, 0x1000, 'rw')).toBe(true);
    expect(space.validateRange(0x200ffc, 4)).toBe(true);
    expect(space.validateRange(0x201000, 0)).toBe(true);
    expect(space.validateRange(0x200ffd, 4)).toBe(false);
    space.releaseRegion(0x200000); space.releaseRegion(0x200000);
    expect(space.validateRange(0x200000, 4)).toBe(false);
    // Registering a higher virtual range must grow the bound, even beyond physical RAM.
    space.registerRegion({base: 0xf0000000, size: 16, perms: 'rw', kind: 'BORROWED'});
    expect(space.validateRange(0xf0000000, 16)).toBe(true);
    space.reset(); expect(space.validateRange(0xf0000000, 4)).toBe(false);
    expect(space.validateRange(0, 4)).toBe(true);
});

test('layout expansion extends the rejection bound', () => {
    const space = new AddressSpace(() => new Uint8Array(0x400000));
    space.registerRegion({base: 0x200000, size: 0x1000, perms: 'rw', kind: 'HEAP', owner: 'Layout'});
    expect(space.validateRange(0x202000, 4)).toBe(false);
    expect(space.expandLayoutBucket('HEAP', 0x4000)).toBe(0x4000);
    expect(space.validateRange(0x203ffc, 4)).toBe(true);
    expect(space.validateRange(0x203ffd, 4)).toBe(false);
});

test('bounded query cache matches an uncached lookup across collisions and mutations', () => {
    const space = new AddressSpace(() => new Uint8Array(0x400000));
    const queries = [0, 0xffffc, 0x100000, 0x200000, 0x200004, 0x200ffc, 0x201000, 0xff000000];
    function verify() {
        const regions = space.getRegions();
        for (let repeat = 0; repeat < 3; repeat++) for (const address of queries)
            for (const size of [0, 4, 8, 4096]) for (const perms of ['r', 'rw', 'rx']) {
                const first = regions.find(r => address >= r.base && address + size <= r.base + r.size);
                const expected = !!first && first.perms !== 'noaccess'
                    && (!perms.includes('w') || first.perms.includes('w'))
                    && (!perms.includes('x') || first.perms.includes('x'));
                expect(space.validateRange(address, size, perms)).toBe(expected);
                expect(space.validateRange(address, size, perms)).toBe(expected);
            }
    }
    verify();
    space.registerRegion({base: 0x200000, size: 0x1000, perms: 'rx', kind: 'BORROWED', allowOverlap: true});
    verify();
    space.registerRegion({base: 0x200000, size: 0x2000, perms: 'rw', kind: 'HEAP', allowOverlap: true});
    verify();
    space.protect(0x200000, 0x1000, 'noaccess'); verify();
    space.releaseRegion(0x200000); verify();
    space.reset(); verify();
});

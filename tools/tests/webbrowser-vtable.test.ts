import { describe, expect, test } from 'bun:test';
import { WEB_BROWSER2_METHOD_ARITIES } from '../../src/worker/modules/ole32';

describe('inert IWebBrowser2 COM layout', () => {
    test('covers the inherited SDK vtable and GoldSrc property setters', () => {
        expect(WEB_BROWSER2_METHOD_ARITIES).toHaveLength(71);
        expect(WEB_BROWSER2_METHOD_ARITIES.slice(0, 7)).toEqual([3, 1, 1, 2, 4, 6, 9]);
        for (const slot of [43, 47, 49, 62, 64, 68]) {
            expect(WEB_BROWSER2_METHOD_ARITIES[slot]).toBe(2);
        }
    });
});

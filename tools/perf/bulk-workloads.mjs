import { createMachine, LEFT, RIGHT } from '../runtime-test/bulk-machine.mjs';
const median = xs => [...xs].sort((a,b) => a-b)[xs.length >> 1];
const sleep = () => new Promise(r => setTimeout(r, 5));

/** Real guest calls; setup, validation and page priming are outside timed batches. */
export async function benchmarkBulk(variants) {
    const machines = [];
    try {
        for (const [name, binary] of Object.entries(variants)) {
            const m = await createMachine(binary, { jit: true, halt: true }); machines.push([name, m]);
            m.paging(); m.guest().fill(47, LEFT, LEFT + 0x200000); m.guest().fill(47, RIGHT, RIGHT + 0x200000);
            m.warm(LEFT, 0x200000, true); m.warm(RIGHT, 0x200000, true);
            m.call('memcpy', RIGHT, LEFT, 64, 250000);
            for (let i=0; i<100 && !m.finalized; i++) await sleep();
            if (!m.finalized) throw new Error(`${name}: guest loop did not JIT compile`);
            m.call('memcpy', RIGHT, LEFT, 64, 10000); await sleep();
        }
        const results = [];
        for (const op of ['memcpy', 'memset', 'memcmp']) for (const len of [16,64,256,4096,65536,1048576]) {
            for (const offset of [0,3]) for (const mode of op === 'memcmp' ? ['equal', 'first', 'last'] : ['full']) {
                const a = RIGHT + offset, b = op === 'memset' ? 47 : LEFT + offset;
                const expected = op === 'memcmp' ? (mode === 'equal' ? 0 : 1) : a;
                const iterations = mode === 'first' ? 20000 : Math.max(8, Math.min(20000, Math.floor(1048576 / len)));
                const samples = Object.fromEntries(machines.map(([name])=>[name,[]]));
                for (const [,m] of machines) {
                    m.guest().fill(47, LEFT, LEFT + len + 32); m.guest().fill(47, RIGHT, RIGHT + len + 32);
                    if (op === 'memcmp' && mode !== 'equal') m.guest()[a + (mode === 'first' ? 0 : len - 1)] = 48;
                    m.warm(LEFT, len + 32, true); m.warm(RIGHT, len + 32, true);
                    const result = m.call(op,a,b,len,64);
                    if (result !== expected) throw new Error('Wrong return value');
                }
                for (let round=0;round<9;round++) {
                    const order = round & 1 ? [...machines].reverse() : machines;
                    for (const [name,m] of order) {
                        m.prepare(op,a,b,len,iterations);
                        const start=performance.now(); const result=m.execute();
                        samples[name].push((performance.now()-start)/iterations);
                        if (result !== expected) throw new Error('Wrong timed return value');
                    }
                }
                for (const [name,m] of machines) {
                    if (m.hostCalls) throw new Error(`${name}: unexpected host fallback`);
                    if (!m.guest().subarray(a,a+len).every((x,i)=>x===(op === 'memcmp' && mode !== 'equal' && i === (mode === 'first' ? 0 : len-1) ? 48 : 47))) throw new Error('Wrong output');
                }
                const medians = Object.fromEntries(Object.entries(samples).map(([name,s])=>[name,median(s)]));
                results.push({case:`${op} ${mode} ${len} bytes +${offset}`,op,len,offset,mode,iterations,mediansMs:medians,samplesMs:samples,
                    speedupVsParent:medians.parent/medians.candidate,
                    speedupVsRebuilt:medians.rebuilt ? medians.rebuilt/medians.candidate : null});
            }
        }
        return { note:'CPU microbenchmarks through JIT-warmed x86 CALL/OUT/RET; warmed valid pages; no staging copies; not game FPS.',
            engines: Object.fromEntries(machines.map(([name,m])=>[name,{jitFinalizations:m.finalized,hostCalls:m.hostCalls,bulkStats:m.stats()}])),results };
    } finally { for (const [,m] of machines) m.close(); }
}

import { convertSurfaceToRGBA, type FormatInfo } from '../../src/worker/modules/ddraw/gpu-texture-utils';

function median(a: number[]): number { return [...a].sort((x,y)=>x-y)[a.length >> 1]; }
function measure(before: () => void, after: () => void, iterations: number) {
    const warmUntil = performance.now() + 30;
    do { before(); after(); } while (performance.now() < warmUntil);
    const run = (fn: () => void) => {
        const start = performance.now();
        for (let i=0; i<iterations; i++) fn();
        return (performance.now()-start)/iterations;
    };
    const beforeSamplesMs: number[] = [], afterSamplesMs: number[] = [];
    for (let i=0; i<9; i++) {
        if (i&1) { afterSamplesMs.push(run(after)); beforeSamplesMs.push(run(before)); }
        else { beforeSamplesMs.push(run(before)); afterSamplesMs.push(run(after)); }
    }
    const beforeMs=median(beforeSamplesMs), afterMs=median(afterSamplesMs);
    return {beforeMs,afterMs,speedup:beforeMs/afterMs,beforeSamplesMs,afterSamplesMs,iterations};
}

export function benchmarkPixels(baseline: {convertSurfaceToRGBA: typeof convertSurfaceToRGBA}) {
    const formats: [string,FormatInfo][] = [
        ['RGB565',{bpp:16,rMask:0xf800,gMask:0x7e0,bMask:31,aMask:0}],
        ['RGB555',{bpp:16,rMask:0x7c00,gMask:0x3e0,bMask:31,aMask:0}],
        ['ARGB1555',{bpp:16,rMask:0x7c00,gMask:0x3e0,bMask:31,aMask:0x8000}],
        ['ARGB8888',{bpp:32,rMask:0xff0000,gMask:0xff00,bMask:255,aMask:0xff000000}],
        ['XRGB8888',{bpp:32,rMask:0xff0000,gMask:0xff00,bMask:255,aMask:0}],
    ];
    let seed=1701;
    const results=[];
    for (const [name,format] of formats) for (const [width,height] of [[4,4],[32,32],[256,256],[800,600],[1024,1024]]) {
        const pitch=width*(format.bpp/8);
        const src=new Uint8Array(pitch*height);
        for(let i=0;i<src.length;i++){ seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;src[i]=seed; }
        const old=new Uint8Array(width*height*4), next=new Uint8Array(old.length);
        for (const key of [undefined,{low:0xf800,high:0xf8ff}]) {
            const before=()=>{baseline.convertSurfaceToRGBA(src,0,width,height,pitch,format,old,key);};
            const after=()=>{convertSurfaceToRGBA(src,0,width,height,pitch,format,next,key);};
            before();after();
            if(!next.every((v,i)=>v===old[i]))throw new Error(`${name} pixel mismatch`);
            const iterations=Math.max(4,Math.min(2000,Math.floor(500000/(width*height))));
            const timing=measure(before,after,iterations);
            if(!next.every((v,i)=>v===old[i]))throw new Error(`${name} output changed during measurement`);
            results.push({case:`${name} ${width}x${height}${key?' + key':''}`,...timing});
        }
    }
    return results;
}

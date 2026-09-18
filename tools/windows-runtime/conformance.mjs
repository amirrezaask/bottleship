import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMath } from './source-loader.mjs';

const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const bitView = new DataView(new ArrayBuffer(4));
const bits = x => { bitView.setFloat32(0, x, true); return bitView.getUint32(0, true); };
const multiply = (a,b) => Array.from({ length:16 }, (_,i) => Math.fround([0,1,2,3].reduce((s,k) => s+a[(i>>2)*4+k]*b[k*4+(i%4)],0)));
const close = (actual, expected, eps = 2e-5) => {
    assert.equal(actual.length, expected.length);
    actual.forEach((x,i) => assert.ok(Math.abs(x-expected[i]) <= eps * Math.max(1,Math.abs(expected[i])), `${i}: ${x} != ${expected[i]}`));
};
async function fixture(tracking=false) {
    const runtime = await loadMath({tracking});
    let bytes = new Uint8Array(8192);
    runtime.Mem.bind(() => bytes, (addr,size) => Number.isInteger(addr) && addr >= 64 && addr+size <= bytes.length);
    const put = (ptr, values) => values.forEach((v,i) => assert.ok(runtime.Mem.writeFloat32(ptr+i*4,v)));
    const get = (ptr, n=16) => Array.from({length:n},(_,i)=>runtime.Mem.readFloat32(ptr+i*4));
    return {...runtime, put, get, bytes: () => bytes, replace: next => {bytes=next;}, call: (name,args) => runtime.functions[name]({},bytes,args)};
}

test('float access stays fresh after replacement, subviews and WebAssembly growth', async () => {
    const f=await fixture();
    f.Mem.writeFloat32(128, 1.25);
    f.replace(new Uint8Array(4096));
    assert.equal(f.Mem.readFloat32(128),0);
    f.Mem.writeFloat64(131, Math.PI);
    assert.equal(f.Mem.readFloat64(131),Math.PI);
    const buffer=new ArrayBuffer(8192);
    f.replace(new Uint8Array(buffer,64,1024)); f.Mem.writeFloat32(128,11);
    f.replace(new Uint8Array(buffer,128,1024)); f.Mem.writeFloat32(128,22);
    assert.equal(new DataView(buffer).getFloat32(192,true),11);
    assert.equal(new DataView(buffer).getFloat32(256,true),22);
    const memory=new WebAssembly.Memory({initial:1,maximum:3});
    f.replace(new Uint8Array(memory.buffer)); f.Mem.writeFloat32(128,7);
    memory.grow(1); f.replace(new Uint8Array(memory.buffer));
    assert.equal(f.Mem.readFloat32(128),7);
    assert.ok(f.Mem.writeFloat32(70000,9)); assert.equal(f.Mem.readFloat32(70000),9);
});
test('cached views survive a resizable buffer shrinking and growing', async () => {
    const f=await fixture();
    const buffer=new ArrayBuffer(4096,{maxByteLength:8192});
    f.replace(new Uint8Array(buffer)); f.Mem.writeFloat32(128,4);
    buffer.resize(1024); f.replace(new Uint8Array(buffer));
    assert.equal(f.Mem.readFloat32(128),4);
    buffer.resize(8192); f.replace(new Uint8Array(buffer));
    assert.ok(f.Mem.writeFloat64(6000,2.5)); assert.equal(f.Mem.readFloat64(6000),2.5);
});
test('cached views cover shared WebAssembly growth and rebinds', async () => {
    const f=await fixture();
    const memory=new WebAssembly.Memory({initial:1,maximum:2,shared:true});
    f.replace(new Uint8Array(memory.buffer)); f.Mem.writeFloat32(128,4);
    memory.grow(1); f.replace(new Uint8Array(memory.buffer));
    assert.equal(f.Mem.readFloat32(128),4);
    assert.ok(f.Mem.writeFloat32(70000,6));
    const other=new Uint8Array(512);
    f.Mem.bind(()=>other); assert.equal(f.Mem.readFloat32(128),0);
});
test('permission failures still reach the memory fault path', async () => {
    const f=await fixture(); f.put(128,[99]);
    f.Mem.bind(f.bytes,(addr,size,perms)=>addr>=64 && addr+size<=f.bytes().length && !perms.includes('w'));
    assert.equal(f.Mem.writeFloat32(128,3),false);
    assert.equal(f.Mem.readFloat32(128),99);
    assert.equal(f.Mem.readFloat64(8190),null);
    assert.equal(f.faults.length,2);
});
test('stable float memory access and existing math hot paths allocate no per-call scratch', async () => {
    const f=await fixture(true); f.put(128,identity); f.put(256,identity); f.put(600,[1,2,3]);
    f.Mem.readFloat32(128); f.resetCounts();
    for(let i=0;i<1000;i++) {
        assert.equal(f.call('D3DXMatrixMultiply',[384,128,256]),384);
        assert.equal(f.call('D3DXMatrixTranslation',[384,bits(i),bits(2),bits(3)]),384);
        assert.equal(f.call('D3DXVec3TransformCoord',[700,600,128]),700);
        f.Mem.writeFloat64(800, i+0.5); f.Mem.readFloat64(800);
    }
    assert.deepEqual(f.counts,{DataView:0,ArrayBuffer:0,Float32Array:0,Float64Array:0});
});
test('float arguments preserve bit patterns including signed zero, infinities and NaN', async () => {
    const f=await fixture();
    for(const value of [0,-0,1,-9.25,Infinity,-Infinity,NaN]) assert.ok(Object.is(f.u32AsFloat(bits(value)),value));
});
test('matrix multiplication matches independent scalar math and aliases either input', async () => {
    const f=await fixture(); let seed=123;
    const random=()=> {seed=(Math.imul(seed,1664525)+1013904223)>>>0; return Math.fround((seed/2**32-0.5)*8);};
    for(let trial=0;trial<100;trial++) {
        const a=Array.from({length:16},random),b=Array.from({length:16},random),expected=multiply(a,b);
        for(const output of [128,256,384,132]) {
            f.put(128,a); f.put(256,b);
            assert.equal(f.call('D3DXMatrixMultiply',[output,128,256]),output);
            close(f.get(output),expected,1e-6);
        }
    }
});
test('transpose and multiply-transpose support in-place output', async () => {
    const f=await fixture(); const a=Array.from({length:16},(_,i)=>i+1);
    f.put(128,a); f.put(256,identity);
    assert.equal(f.call('D3DXMatrixMultiplyTranspose',[128,128,256]),128);
    close(f.get(128),Array.from({length:16},(_,i)=>a[(i%4)*4+(i>>2)]));
    assert.equal(f.call('D3DXMatrixTranspose',[128,128]),128); close(f.get(128),a);
});
test('LH and RH look-at produce the documented forward axes', async () => {
    const f=await fixture(); f.put(600,[0,0,0]); f.put(620,[0,0,1]); f.put(640,[0,1,0]);
    assert.equal(f.call('D3DXMatrixLookAtLH',[128,600,620,640]),128); close(f.get(128),identity);
    f.put(620,[0,0,-1]);
    assert.equal(f.call('D3DXMatrixLookAtRH',[128,600,620,640]),128); close(f.get(128),identity);
    f.put(600,[3,4,5]); f.put(620,[3,4,6]);
    f.call('D3DXMatrixLookAtLH',[128,600,620,640]);
    f.call('D3DXVec3TransformCoord',[700,600,128]); close(f.get(700,3),[0,0,0]);
    f.call('D3DXVec3TransformCoord',[700,620,128]); close(f.get(700,3),[0,0,1]);
});
test('scaling and XYZ rotations follow row-vector orientation', async () => {
    const f=await fixture(); f.call('D3DXMatrixScaling',[128,bits(2),bits(3),bits(4)]);
    f.put(600,[1,1,1]); f.call('D3DXVec3TransformCoord',[700,600,128]); close(f.get(700,3),[2,3,4]);
    for(const [axis,input,expected] of [['X',[0,1,0],[0,0,1]],['Y',[1,0,0],[0,0,-1]],['Z',[1,0,0],[0,1,0]]]) {
        f.put(600,input); f.call(`D3DXMatrixRotation${axis}`,[128,bits(Math.PI/2)]);
        f.call('D3DXVec3TransformCoord',[700,600,128]); close(f.get(700,3),expected);
    }
});
test('perspective and orthographic LH/RH map near/far to zero/one depth', async () => {
    const f=await fixture();
    for(const handed of ['LH','RH']) for(const projection of ['PerspectiveFov','Ortho']) {
        f.call(`D3DXMatrix${projection}${handed}`,[128,bits(projection==='Ortho'?4:Math.PI/2),bits(2),bits(1),bits(10)]);
        for(const [z,expected] of [[1,0],[10,1]]) {
            f.put(600,[0,0,handed==='LH'?z:-z]);
            f.call('D3DXVec3TransformCoord',[700,600,128]); close(f.get(700,3),[0,0,expected]);
        }
    }
});
test('inverse pivots, reports determinant, aliases and rejects singular matrices', async () => {
    const f=await fixture(); const a=[0,2,0,0, 3,0,0,0, 0,0,4,0, 5,6,7,1];
    f.put(128,a); assert.equal(f.call('D3DXMatrixInverse',[128,700,128]),128);
    close(multiply(a,f.get(128)),identity); assert.equal(f.Mem.readFloat32(700),-24);
    f.put(256,new Array(16).fill(0)); f.put(384,identity);
    assert.equal(f.call('D3DXMatrixInverse',[384,700,256]),0);
    close(f.get(384),identity); assert.equal(f.Mem.readFloat32(700),0);
    f.put(128,a); assert.equal(f.call('D3DXMatrixInverse',[384,0,128]),384);
});
test('normal excludes translation; full transform retains homogeneous w', async () => {
    const f=await fixture(); const a=[2,0,0,1, 0,3,0,2, 0,0,4,3, 10,20,30,1];
    f.put(128,a); f.put(600,[1,2,3]);
    f.call('D3DXVec3TransformNormal',[600,600,128]); close(f.get(600,3),[2,6,12]);
    f.put(600,[1,2,3]); f.call('D3DXVec3Transform',[600,600,128]); close(f.get(600,4),[12,26,42,15]);
});
test('near-parallel line intersections are not mistaken for parallel', async () => {
    const f=await fixture(); f.put(600,[0,1,0,0]); f.put(640,[0,1e-10,0]); f.put(680,[1,-1e-10,0]);
    assert.equal(f.call('D3DXPlaneIntersectLine',[700,600,640,680]),700); close(f.get(700,3),[0.5,0,0]);
    f.put(680,[1,1e-10,0]); f.put(700,[9,8,7]);
    assert.equal(f.call('D3DXPlaneIntersectLine',[700,600,640,680]),0); close(f.get(700,3),[9,8,7]);
});
test('null and invalid source pointers fail without stale scratch output', async () => {
    const f=await fixture(); f.put(128,identity); f.put(384,identity);
    assert.equal(f.call('D3DXMatrixMultiply',[384,128,0]),0); close(f.get(384),identity);
    assert.equal(f.call('D3DXMatrixMultiply',[384,128,8180]),0); close(f.get(384),identity);
    assert.equal(f.call('D3DXMatrixIdentity',[0]),0);
});
test('math factory instances keep independent scratch', async () => {
    const f=await fixture(); const module=await f.load('src/worker/modules/d3dx9/math.ts');
    const other=module.createMathExports();
    f.call('D3DXMatrixTranslation',[128,bits(4),bits(5),bits(6)]);
    other.D3DXMatrixIdentity({},f.bytes(),[256]);
    close(f.get(128).slice(12,15),[4,5,6]); close(f.get(256),identity);
});

test('every math export is registered with a documented stdcall descriptor', async () => {
    const f=await fixture();
    const {d3dx9Module}=await f.load('src/worker/api/d3dx9.api.ts');
    const descriptors=new Map(d3dx9Module.functions.map(x=>[x.name,x]));
    const {D3dx9}=await f.load('src/worker/modules/d3dx9/index.ts');
    const module=new D3dx9(); module.initialize({});
    for(const name of Object.keys(f.functions)) {
        assert.ok(descriptors.has(name),name);
        assert.equal(descriptors.get(name).callingConvention,'stdcall');
        assert.equal(typeof module.exports[name],'function');
    }
    f.put(128,identity);
    assert.equal(module.exports.D3DXMatrixTranspose({},f.bytes(),[256,128]),256);
    close(f.get(256),identity);
    const counts={D3DXCheckVersion:2,D3DXCreateTextureFromFileA:3,D3DXCreateTextureFromFileW:3,
        D3DXCreateTextureFromFileInMemory:4,D3DXGetImageInfoFromFileA:2,D3DXGetImageInfoFromFileW:2,
        D3DXCreateFontA:12,D3DXCreateFontW:12,D3DXCreateFontIndirectA:3,D3DXCreateFontIndirectW:3};
    for(const [name,count] of Object.entries(counts)) assert.equal(descriptors.get(name).params.length,count,name);
});
test('image metadata writes exactly 28 bytes, with source mip count and file format', async () => {
    const f=await fixture();
    const {writeImageInfo}=await f.load('src/worker/modules/d3dx9/image-info.ts');
    f.bytes().fill(0xcd);
    for(const format of [0,1,2,3,4]) {
        assert.ok(writeImageInfo(128,{width:64,height:32,sourceMipLevels:1,imageFileFormat:format}));
        const view=new DataView(f.bytes().buffer);
        assert.deepEqual(Array.from({length:7},(_,i)=>view.getUint32(128+i*4,true)),[64,32,1,1,21,3,format]);
        assert.equal(view.getUint32(124,true),0xcdcdcdcd);
        assert.equal(view.getUint32(156,true),0xcdcdcdcd);
    }
    assert.equal(writeImageInfo(0,{width:1,height:1,sourceMipLevels:1,imageFileFormat:0}),false);
    f.Mem.bind(f.bytes,(addr,size)=>addr>=128 && addr+size<=156);
    assert.ok(writeImageInfo(128,{width:1,height:1,sourceMipLevels:1,imageFileFormat:0}));
});

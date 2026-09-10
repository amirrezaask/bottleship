/** Compare the compiled CPU with actual host REP instructions, independently of v86's old path. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRepMachine,LEFT,RIGHT} from '../runtime-test/rep-machine.mjs';
const oracle=process.argv[2];if(!oracle)throw new Error('Usage: node verify-rep-native.mjs <native-oracle> [report.json]');
const cases=[];
for(const op of [0,1,2])for(const size of [1,2,4])for(const eq of [0,1])for(const backwards of [0,1])for(const count of [0,1,7,16,17,63,65,129]){
    for(const value of [0,1,0x7f,0x80,0x8000,0x80000000,0xffffffff,0x89abf17e])for(const stop of new Set([-1,0,count-1]))for(const offset of [0,3]){
        cases.push([op,size,eq,backwards,count,value,0x8d7,stop,offset]);
    }
}
const native=execFileSync(oracle,[],{input:cases.map(c=>c.join(' ')).join('\n')+'\n',encoding:'utf8',maxBuffer:8*1024*1024}).trim().split('\n');
assert.equal(native.length,cases.length);
const m=await createRepMachine(readFileSync(process.env.V86_TEST_BINARY||new URL('../../public/v86.wasm',import.meta.url)));
try{
    m.paging();const mem=m.guest(),view=new DataView(mem.buffer,mem.byteOffset);
    const put=(p,size,x)=>size===1?view.setUint8(p,x):size===2?view.setUint16(p,x,true):view.setUint32(p,x>>>0,true);
    for(let index=0;index<cases.length;index++){
        const [op,size,eq,backwards,count,value,flags,stop,offset]=cases[index];
        for(let i=0;i<count;i++){
            put(LEFT+offset+i*size,size,value);const pos=backwards?count-1-i:i;
            put(RIGHT+offset+i*size,size,pos===stop?(eq?value^0x81:value):(eq?value:value^0x81));
        }
        const start=offset+(backwards&&count?(count-1)*size:0);
        const r=m.rep(['cmps','scas','stos'][op],size,LEFT+start,RIGHT+start,count,{equal:!!eq,backwards:!!backwards,value,flags});
        let hash=2166136261;for(let i=0;i<count*size;i++)hash=Math.imul(hash^mem[RIGHT+offset+i],16777619)>>>0;
        assert.deepEqual([r.ecx,r.esi-LEFT,r.edi-RIGHT,r.flags&0xcd5,hash],native[index].split(' ').map(Number),`native REP case ${index}: ${cases[index]}`);
    }
    const report={cases:cases.length,passed:cases.length,hostArch:process.arch,hostCalls:m.hostCalls,repStats:m.repStats(),note:'Native x86-64 REP operand/count/direction/arithmetic-flag oracle. It does not test guest address translation, exceptions, 16-bit wrap or native performance.'};
    console.log(JSON.stringify(report,null,2));if(process.argv[3])writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');
}finally{m.close();}

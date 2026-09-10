import {test,expect} from 'bun:test';
import {HypercallDataManager} from '../../src/worker/core/cpu/hypercall-data';
function setup(version?: number){
    const wasm_memory=new WebAssembly.Memory({initial:2});
    const cpu={wasm_memory,wm:{exports:version===undefined?{}:{get_string_memory_abi:()=>version}}};
    const manager=new HypercallDataManager();manager.initialize(cpu,4096);
    return {manager,cpu,entry:(id:number)=>new Uint8Array(wasm_memory.buffer)[4096+0x100+id]};
}
test('string search handlers require the exact version; CRT aliases and old handlers stay compatible',()=>{
    for(const v of [undefined,0,1,2]){
        const {manager,entry}=setup(v);
        for(const [dll,name,id,handler] of [['msvcrt','strchr',1,84],['crtdll','strrchr',2,85],['MSVCR90','STRCHR',3,84],['msvcr90','strrchr',4,85]] as const){
            manager.registerFunction(dll,name,id);expect(entry(id)).toBe(v===1?handler:0);
        }
        manager.registerFunction('msvcrt','strlen',5);expect(entry(5)).toBe(58);
        manager.registerFunction('msvcrt','memmove',6);expect(entry(6)).toBe(0);
    }
});
test('registration refreshes memory views and invalid IDs cannot alias valid dispatch slots',()=>{
    const {manager,cpu,entry}=setup(1);manager.registerFunction('msvcrt','strchr',1);
    cpu.wasm_memory.grow(1);manager.registerFunction('msvcrt','strrchr',2);expect(entry(1)).toBe(84);expect(entry(2)).toBe(85);
    const before=new Uint8Array(cpu.wasm_memory.buffer).slice();
    for(const id of [NaN,Infinity,-Infinity,-1,0,1.5,2.5,4096,999999]){
        manager.registerFunction('msvcrt','strchr',id);manager.unregisterRawHandler(id);manager.registerRawHandler(id,128);
        manager.registerRawHandler(1,id===0?NaN:id+0.25);
    }
    expect(new Uint8Array(cpu.wasm_memory.buffer)).toEqual(before);
    expect(entry(0)).toBe(0);expect(entry(1)).toBe(84);expect(entry(2)).toBe(85);
});

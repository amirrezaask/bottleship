import {benchmarkRep} from './rep-workloads.mjs';
export function unalignedCases(){
    const configs=[];
    for(const op of ['cmps','scas'])for(const size of [2,4])for(const equal of [false,true])configs.push({op,size,equal,value:0x89abf17e});
    for(const size of [2,4])for(const value of [0,0x12345678])configs.push({op:'stos',size,equal:true,value});
    const cases=[];
    for(const c of configs)for(const length of [0,8,4096,65536])for(const backwards of [false,true]){
        cases.push({...c,length,backwards,offset:3,mode:'full',requireUnaligned:length>=4096});
    }
    for(const c of configs)for(const backwards of [false,true]){
        for(const offset of [0,1])cases.push({...c,length:4096,backwards,offset,mode:'full',requireUnaligned:offset===1});
    }
    for(const c of configs.filter(c=>c.op==='cmps'))for(const backwards of [false,true]){
        for(const [offset,dstOffset] of [[0,1],[1,0],[1,2],[2,1],[4093,4095]])cases.push({...c,length:4096,backwards,offset,dstOffset,mode:'full',requireUnaligned:true});
    }
    for(const c of configs.filter(c=>c.op!=='stos'))for(const backwards of [false,true])for(const mode of ['first','last']){
        cases.push({...c,length:4096,backwards,offset:3,mode,requireUnaligned:true});
    }
    for(const op of ['movs','stos'])for(const length of [4096,65536])for(const backwards of [false,true]){
        cases.push({op,size:1,equal:true,value:47,length,backwards,offset:3,mode:'full'});
    }
    return cases;
}
export const benchmarkUnaligned=variants=>benchmarkRep(variants,unalignedCases());

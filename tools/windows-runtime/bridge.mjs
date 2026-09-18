import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const path='src/gamebox-bridge.js';
const baselineRef=process.env.WINDOWS_BASELINE_REF||'3c194209799afea7cbaecb0eb1e8170a5cafb735';
const baselineSource=execFileSync('git',['show',`${baselineRef}:${path}`],{encoding:'utf8'});
const candidateSource=readFileSync(path,'utf8');
const load=async source=>(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).installGameBoxBridge;
const before=await load(baselineSource),after=await load(candidateSource);
function setup(install){
  const previous=globalThis.window,window=new EventTarget(),worker=new EventTarget(),statuses=[];
  let received=0;
  globalThis.window=window;
  window.addEventListener('gamebox:bottleship-status',()=>statuses.push(window.GameBoxBottleShip.status));
  worker.addEventListener('message',()=>received++);
  install(worker,async()=>{});
  return {window,worker,statuses,received:()=>received,
    send:data=>worker.dispatchEvent(new MessageEvent('message',{data})),
    restore:()=>{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;}};
}
test('real host bridge eliminates repeated phase DOM events without dropping worker progress',()=>{
  const run=install=>{const f=setup(install);try{for(let i=0;i<1000;i++)f.send({type:'loading_progress',phase:'downloading',percent:i/10});return {statusEvents:f.statuses.length,workerMessages:f.received(),status:f.window.GameBoxBottleShip.status};}finally{f.restore();}};
  const baseline=run(before),candidate=run(after);
  assert.equal(baseline.statusEvents,1000);assert.equal(candidate.statusEvents,1);assert.equal(candidate.workerMessages,1000);assert.equal(candidate.status,baseline.status);
  mkdirSync('evidence',{recursive:true});writeFileSync('evidence/bridge-work.json',JSON.stringify({schemaVersion:1,scope:'actual host source, Node EventTarget workload; NOT browser FPS',baselineRef,baseline,candidate,baselineSourceSha256:createHash('sha256').update(baselineSource).digest('hex'),candidateSourceSha256:createHash('sha256').update(candidateSource).digest('hex')},null,2)+'\n');
});
test('ready, phase changes, first present, errors and exit remain observable',()=>{
  const f=setup(after);try{
    f.send({type:'ready'});assert.equal(f.window.GameBoxBottleShip.ready,true);
    f.send({type:'loading_progress',phase:'downloading'});f.send({type:'loading_progress',phase:'caching'});f.send({type:'loading_progress',phase:'done'});f.send({type:'first_present'});
    assert.deepEqual(f.statuses,['BottleShip ready','Loading game: downloading','Loading game: caching','Starting game…','Playing']);
    f.send({type:'error',message:'device lost'});assert.equal(f.statuses.at(-1),'device lost');f.send({type:'loading_progress',phase:'caching'});assert.equal(f.statuses.at(-1),'device lost');
  }finally{f.restore();}
  const exit=setup(after);try{exit.send({type:'process_exit',crashed:false});exit.send({type:'loading_progress',phase:'caching'});assert.deepEqual(exit.statuses,['Game exited']);assert.equal(exit.window.GameBoxBottleShip.exited,true);}finally{exit.restore();}
});

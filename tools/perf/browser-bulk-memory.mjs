/** Real-clock Chrome CPU benchmark. No game, GPU or native-driver timing. */
import {createServer} from 'node:http';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {tmpdir,cpus} from 'node:os';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url));
const base=process.argv[2]||'9501efd8bc208be8e67f72f226bb795255451bc7';
const git=(...args)=>execFileSync('git',args,{cwd:root,maxBuffer:16*1024*1024});
const binaries=new Map([
    ['/parent.wasm',git('show',`${base}:public/v86.wasm`)],
    ['/candidate.wasm',await readFile(process.env.V86_TEST_BINARY||resolve(root,'public/v86.wasm'))],
]);
if(process.env.V86_REBUILT_BASELINE)binaries.set('/rebuilt.wasm',await readFile(process.env.V86_REBUILT_BASELINE));
let complete;const completed=new Promise(resolve=>{complete=resolve;});
const page=`<!doctype html><meta charset="utf-8"><script>
window.report=x=>fetch('/result',{method:'POST',body:JSON.stringify(x)});
window.addEventListener('error',e=>window.report({error:e.message}));
window.addEventListener('unhandledrejection',e=>window.report({error:String(e.reason)}));
</script><script type="module">
import {benchmarkBulk} from '/tools/perf/bulk-workloads.mjs';
try {
 const variants={};
 for(const name of ${JSON.stringify([...binaries.keys()].map(p=>p.slice(1,-5)))}){
  const response=await fetch('/'+name+'.wasm');if(!response.ok)throw new Error('WASM fetch failed');
  variants[name]=await response.arrayBuffer();
 }
 await window.report({userAgent:navigator.userAgent,...await benchmarkBulk(variants)});
}catch(e){await window.report({error:String(e),stack:e.stack});}
</script>`;
const server=createServer(async(req,res)=>{
    try{
        res.setHeader('Cross-Origin-Opener-Policy','same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
        const path=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
        if(path==='/result'&&req.method==='POST'){
            let body='';for await(const chunk of req){body+=chunk;if(body.length>2*1024*1024)throw new Error('Report too large');}
            complete(JSON.parse(body));res.end('ok');return;
        }
        if(path==='/'){res.setHeader('Content-Type','text/html');res.end(page);return;}
        if(binaries.has(path)){res.setHeader('Content-Type','application/wasm');res.end(binaries.get(path));return;}
        const target=resolve(root,'.'+path);
        if(!target.startsWith(resolve(root)+sep)||!target.endsWith('.mjs')){res.writeHead(403);res.end();return;}
        res.setHeader('Content-Type','text/javascript');res.end(await readFile(target));
    }catch(e){res.writeHead(404);res.end(String(e));}
});
const profile=await mkdtemp(resolve(tmpdir(),'bottleship-bulk-'));let child,timer;
try{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    let chrome=process.env.CHROME_BIN;
    if(!chrome)for(const bin of ['google-chrome','chromium','chromium-browser']){
        try{execFileSync(bin,['--version'],{stdio:'ignore'});chrome=bin;break;}catch{/* Try next installed browser. */}
    }
    if(!chrome)throw new Error('Set CHROME_BIN to installed Chrome/Chromium');
    const args=['--headless=new','--disable-gpu','--no-first-run','--disable-dev-shm-usage',
        '--disable-background-timer-throttling',`--user-data-dir=${profile}`,`http://127.0.0.1:${server.address().port}/`];
    if(process.getuid?.()===0)args.unshift('--no-sandbox');
    child=spawn(chrome,args,{stdio:['ignore','ignore','pipe']});let stderr='';
    child.stderr.on('data',x=>{stderr=(stderr+x).slice(-16000);});
    const result=await Promise.race([completed,
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Benchmark timeout: ${stderr}`)),60000);}),
        new Promise((_,reject)=>{child.once('error',reject);child.once('exit',code=>reject(new Error(`Chrome exit ${code}: ${stderr}`)));}),
    ]);
    if(result.error)throw new Error(JSON.stringify(result));
    const report={base,head:git('rev-parse','HEAD').toString().trim(),cpu:cpus()[0]?.model,
        binaryHashes:Object.fromEntries([...binaries].map(([name,bytes])=>[name,createHash('sha256').update(bytes).digest('hex')])),...result};
    console.table(report.results.map(r=>({case:r.case,parentMs:r.mediansMs.parent,candidateMs:r.mediansMs.candidate,speedup:r.speedupVsParent,controlled:r.speedupVsRebuilt})));
    if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(report,null,2)+'\n');
}finally{
    clearTimeout(timer);
    if(child&&child.exitCode===null){const stopped=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await stopped;}
    server.closeAllConnections();server.close();
    await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}

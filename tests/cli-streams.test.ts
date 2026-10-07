import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fixture, contextFor } from './helpers.ts';
const entry=process.env.CACHESCOPE_TEST_CLI??resolve('dist/cli.js');
async function run(args:string[],close:'stdout'|'stderr'|'both') {
 return new Promise<{code:number|null;out:string;err:string}>((done,reject)=>{
  const child=spawn(process.execPath,[entry,...args],{stdio:['ignore','pipe','pipe']});let out='',err='';
  child.on('error',()=>reject(new Error('CHILD_START_FAILED')));
  child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  if(close==='stdout'||close==='both')child.stdout.destroy();
  if(close==='stderr'||close==='both')child.stderr.destroy();
  child.on('close',code=>done({code,out,err}));
 });
}
function verify(r:{code:number|null;out:string;err:string}) {
 // Only safe counts/flags are included in assertion messages; never print captured exceptions.
 const s=r.out+r.err;const evidence={code:r.code,stderrBytes:Buffer.byteLength(r.err),rawException:/EPIPE|Unhandled|\bat .*\(|node:events|node:internal/.test(s),absolutePath:s.includes(process.cwd())||s.includes(process.cwd().replaceAll('\\','/'))};
 assert.equal(r.code,3,JSON.stringify(evidence));assert.equal(evidence.rawException,false);assert.equal(evidence.absolutePath,false);
}
for(const [label,args]of [ ['version',['--version']],['help',['--help']],['summary',['demo']],['json',['demo','--json']],['error envelope',['--invalid','--json']] ] as const){
 test(`closed stdout: ${label} exits 3 without raw stream exceptions`,async()=>{const r=await run([...args],'stdout');verify(r);assert.equal(r.err,'output: STDOUT_WRITE_FAILED\n');});
}
test('closed stderr on an error does not recurse into a failed stream or write stdout',async()=>{const r=await run(['--invalid'],'stderr');verify(r);assert.equal(r.out,'');});
test('both closed streams finish safely with exit 3',async()=>verify(await run(['--version'],'both')));
test('stdout failure after file outputs preserves both completed reports and reports partial output',async()=>{
 const f=await fixture();try{const html=join(f.dir,'kept.html'),json=join(f.dir,'kept.json');const before=await readFile(f.paths.workflow);const r=await run(['--workflow',f.paths.workflow,'--run-a',f.paths.runA,'--run-b',f.paths.runB,'--html',html,'--output-json',json,'--json'],'stdout');verify(r);assert.equal(r.err,'output: PARTIAL_OUTPUT\n');const report=JSON.parse(await readFile(json,'utf8'));assert.equal(report.schemaVersion,1);assert.ok((await readFile(html,'utf8')).includes('CacheScope'));assert.deepEqual(await readFile(f.paths.workflow),before);}finally{await f.cleanup();}
});
test('closed stderr after a summary diagnostic raises exit 3 without corrupting stdout',async()=>{
 const f=await fixture(undefined,'Cache unknown statement','Cache unknown statement',contextFor());try{const r=await run(['--workflow',f.paths.workflow,'--run-a',f.paths.runA,'--run-b',f.paths.runB,'--context',f.paths.context!],'stderr');verify(r);assert.match(r.out,/^CacheScope ·/);}finally{await f.cleanup();}
});


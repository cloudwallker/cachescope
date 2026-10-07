import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAnalysisInputs, prepareOutputs } from '../src/input.ts';
import { writeOutputs } from '../src/output.ts';
import { fixture } from './helpers.ts';
import { join } from 'node:path';
test('a failed payload validation consumes its authentic permit',async()=>{const f=await fixture();try{const l=await loadAnalysisInputs(f.paths);assert.ok(l.ok);const p=await prepareOutputs(l.value,[{kind:'json',path:join(f.dir,'x.json')}],{overwrite:false});assert.ok(p.ok);assert.equal((await writeOutputs(p.value,[])).ok,false);assert.equal((await writeOutputs(p.value,[{kind:'json',utf8:Buffer.from('{}')}])).ok,false)}finally{await f.cleanup()}});

test('writer validates the actual snapshot even if a caller accessor changes payload bytes',async()=>{const f=await fixture();try{const l=await loadAnalysisInputs(f.paths);assert.ok(l.ok);const p=await prepareOutputs(l.value,[{kind:'json',path:join(f.dir,'snapshot-limit.json')}],{overwrite:false});assert.ok(p.ok);let reads=0;const payload={kind:'json' as const,get utf8(){return ++reads>3?new Uint8Array(16*1024*1024+1):Buffer.from('{}')}};assert.equal((await writeOutputs(p.value,[payload])).ok,false)}finally{await f.cleanup()}});

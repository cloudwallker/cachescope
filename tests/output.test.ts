import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, link, symlink, mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture } from './helpers.ts';
import { loadAnalysisInputs, prepareOutputs } from '../src/input.ts';
import { LIMITS, hash } from '../src/safety.ts';
const payload = (kind: 'html' | 'json', s: string) => ({ kind, utf8: Buffer.from(s) });
test('writer persists two exclusive outputs and atomically replaces two existing outputs', async () => {
    const f = await fixture();
    try {
        const loaded = await loadAnalysisInputs(f.paths);
        assert.ok(loaded.ok);
        const m = await import('../src/output.ts').catch(() => null);
        assert.ok(m, 'guarded writer must exist');
        const paths = [join(f.dir, 'one.html'), join(f.dir, 'two.json')];
        const requests = paths.map((path, i) => ({ kind: i === 0 ? 'html' as const : 'json' as const, path }));
        const before = hash(await readFile(f.paths.workflow));
        for (const overwrite of [false, true]) {
            const p = await prepareOutputs(loaded.value, requests, { overwrite });
            assert.ok(p.ok);
            assert.deepEqual(await m.writeOutputs(p.value, [payload('html', overwrite ? 'new html' : 'html'), payload('json', overwrite ? 'new json' : 'json')]), { ok: true, value: null });
            assert.equal(await readFile(paths[0]!, 'utf8'), overwrite ? 'new html' : 'html');
            assert.equal(await readFile(paths[1]!, 'utf8'), overwrite ? 'new json' : 'json');
        }
        assert.equal(hash(await readFile(f.paths.workflow)), before);
    }
    finally {
        await f.cleanup();
    }
});
test('writer rejects payload boundary plus one before creating any file and rejects forged permit', async () => {
    const f = await fixture();
    try {
        const loaded = await loadAnalysisInputs(f.paths);
        assert.ok(loaded.ok);
        const m = await import('../src/output.ts').catch(() => null);
        assert.ok(m);
        const path = join(f.dir, 'oversize.json');
        const p = await prepareOutputs(loaded.value, [{ kind: 'json', path }], { overwrite: false });
        assert.ok(p.ok);
        const r = await m.writeOutputs(p.value, [{ kind: 'json', utf8: new Uint8Array(LIMITS.json + 1) }]);
        assert.equal(r.ok, false);
        await assert.rejects(stat(path));
        assert.equal((await m.writeOutputs({} as any, [])).ok, false);
    }
    finally {
        await f.cleanup();
    }
});
test('input aliases and multi-output collisions are refused; root escape and stale input fail closed', async () => {
    const f = await fixture();
    try {
        const aliases = [f.paths.workflow, resolve(f.dir, '..', f.dir.split(/[\\/]/).at(-1)!, 'workflow.yml')];
        if (process.platform === 'win32')
            aliases.push(f.paths.workflow.toUpperCase());
        const hard = join(f.dir, 'hard.yml');
        await link(f.paths.workflow, hard);
        aliases.push(hard);
        const soft = join(f.dir, 'soft.yml');
        await symlink(f.paths.workflow, soft, 'file');
        const junction = join(f.dir, 'junction');
        await symlink(f.dir, junction, process.platform === 'win32' ? 'junction' : 'dir');
        aliases.push(join(junction, 'workflow.yml'));
        // Create all links before loading: hardlink creation changes the input identity's ctime.
        const l = await loadAnalysisInputs(f.paths);
        assert.ok(l.ok);
        const rejectedWith = (result: Awaited<ReturnType<typeof prepareOutputs>>, code: string) => {
            assert.equal(result.ok, false);
            if (!result.ok) assert.equal(result.diagnostics[0]!.code, code);
        };
        for (const path of aliases)
            rejectedWith(await prepareOutputs(l.value, [{ kind: 'json', path }], { overwrite: true }), 'OUTPUT_INPUT_ALIAS');
        rejectedWith(await prepareOutputs(l.value, [{ kind: 'json', path: soft }], { overwrite: true }), 'OUTPUT_LEAF_LINK');
        const out = join(f.dir, 'output');
        await mkdir(out);
        rejectedWith(await prepareOutputs(l.value, [{ kind: 'json', path: join(f.dir, 'out.json') }], { overwrite: false, outputRoot: out }), 'OUTPUT_ROOT_ESCAPE');
        rejectedWith(await prepareOutputs(l.value, [{ kind: 'json', path: join(out, 'x') }, { kind: 'html', path: join(out, 'x') }], { overwrite: false }), 'OUTPUT_COLLISION');
        const fresh = await loadAnalysisInputs(f.paths);
        assert.ok(fresh.ok);
        const p = await prepareOutputs(fresh.value, [{ kind: 'json', path: join(out, 'stale.json') }], { overwrite: false });
        assert.ok(p.ok);
        await writeFile(f.paths.runA, 'changed');
        const m = await import('../src/output.ts');
        const stale = await m.writeOutputs(p.value, [payload('json', '{}')]);
        assert.equal(stale.ok, false);
        if (!stale.ok) assert.equal(stale.diagnostics[0]!.code, 'INPUT_CHANGED');
        await assert.rejects(stat(join(out, 'stale.json')));
    }
    finally {
        await f.cleanup();
    }
});
import { open, watch as watchFs, writeFileSync } from 'node:fs';
import { open as openHandle, readdir } from 'node:fs/promises';
import { beginOutputSession, outputSessionPlan, registerOutputHandle, sealOutputHandle, validateOutputSession, commitOutputHandle, cleanupOutputSession } from '../src/input.ts';
import { writeOutputs } from '../src/output.ts';
test('single-use permits snapshot mutable payloads and reject reuse or concurrent writers', async () => {
    const f = await fixture();
    try {
        const l = await loadAnalysisInputs(f.paths);
        assert.ok(l.ok);
        const path = join(f.dir, 'snapshot.json');
        const p = await prepareOutputs(l.value, [{ kind: 'json', path }], { overwrite: false });
        assert.ok(p.ok);
        const bytes = Buffer.from('{"safe":true}');
        const running = writeOutputs(p.value, [{ kind: 'json', utf8: bytes }]);
        bytes.fill(120);
        assert.equal((await writeOutputs(p.value, [payload('json', 'bad')])).ok, false);
        assert.ok((await running).ok);
        assert.equal(await readFile(path, 'utf8'), '{"safe":true}');
        assert.equal((await writeOutputs(p.value, [payload('json', 'bad')])).ok, false);
    }
    finally {
        await f.cleanup();
    }
});
test('mixed create/overwrite writes exact payloads and rejects stale destination before publication', async () => {
    const f = await fixture();
    try {
        const a = join(f.dir, 'a.html'), b = join(f.dir, 'b.json');
        await writeFile(b, 'old');
        const l = await loadAnalysisInputs(f.paths);
        assert.ok(l.ok);
        const p = await prepareOutputs(l.value, [{ kind: 'html', path: a }, { kind: 'json', path: b }], { overwrite: true });
        assert.ok(p.ok);
        assert.ok((await writeOutputs(p.value, [payload('html', 'html'), payload('json', 'json')])).ok);
        assert.equal(await readFile(b, 'utf8'), 'json');
        const c = join(f.dir, 'late');
        const q = await prepareOutputs(l.value, [{ kind: 'json', path: c }], { overwrite: false });
        assert.ok(q.ok);
        await writeFile(c, 'external');
        assert.equal((await writeOutputs(q.value, [payload('json', 'mine')])).ok, false);
        assert.equal(await readFile(c, 'utf8'), 'external');
    }
    finally {
        await f.cleanup();
    }
});
test('owned handle bridge refuses foreign handles and detects committed file tampering', async () => {
    const f = await fixture();
    try {
        const l = await loadAnalysisInputs(f.paths);
        assert.ok(l.ok);
        const path = join(f.dir, 'checked');
        const p = await prepareOutputs(l.value, [{ kind: 'json', path }], { overwrite: false });
        assert.ok(p.ok);
        const session = beginOutputSession(p.value, [payload('json', 'safe')]);
        assert.ok(session.ok);
        const plan = outputSessionPlan(session.value);
        assert.ok(plan.ok);
        const foreign = await openHandle(f.paths.runA, 'r');
        assert.equal((await registerOutputHandle(session.value, 0, foreign)).ok, false);
        await foreign.close();
        const h = await openHandle(plan.value.staging[0]!, 'wx+');
        assert.ok((await registerOutputHandle(session.value, 0, h)).ok);
        await h.writeFile('safe');
        assert.ok((await sealOutputHandle(session.value, 0)).ok);
        await link(plan.value.staging[0]!, path);
        assert.ok((await commitOutputHandle(session.value, 0)).ok);
        assert.ok((await validateOutputSession(session.value)).ok);
        await writeFile(path, 'evil');
        assert.equal((await validateOutputSession(session.value)).ok, false);
        await cleanupOutputSession(session.value);
        assert.equal(await readFile(path, 'utf8'), 'evil');
        assert.equal((await validateOutputSession(session.value)).ok, false);
    }
    finally {
        await f.cleanup();
    }
});
test('partial output keeps successful first file and cleans only its own staging files', async () => {
    const f = await fixture();
    try {
        const l = await loadAnalysisInputs(f.paths);
        assert.ok(l.ok);
        const a = join(f.dir, 'first.html'), b = join(f.dir, 'second.json');
        const p = await prepareOutputs(l.value, [{ kind: 'html', path: a }, { kind: 'json', path: b }], { overwrite: false });
        assert.ok(p.ok);
        const unrelated = join(f.dir, '.cachescope-user.tmp');
        await writeFile(unrelated, 'user');
        const watcher = watchFs(f.dir, (_event, file) => { if (String(file) === 'first.html')
            writeFileSync(b, 'external'); });
        const result = await writeOutputs(p.value, [payload('html', 'first'), payload('json', 'second')]);
        watcher.close();
        assert.equal(result.ok, false);
        if (!result.ok)
            assert.equal(result.diagnostics[0]!.code, 'PARTIAL_OUTPUT');
        assert.equal(await readFile(a, 'utf8'), 'first');
        assert.equal(await readFile(b, 'utf8'), 'external');
        assert.deepEqual((await readdir(f.dir)).filter(x => x.startsWith('.cachescope-')), ['.cachescope-user.tmp']);
    }
    finally {
        await f.cleanup();
    }
});
test('session refuses a replaced parent and changed input before any destination write', async () => {
    const f = await fixture();
    try {
        const { rename } = await import('node:fs/promises');
        const parent = join(f.dir, 'parent');
        await mkdir(parent);
        const l = await loadAnalysisInputs(f.paths);
        assert.ok(l.ok);
        const p = await prepareOutputs(l.value, [{ kind: 'json', path: join(parent, 'x') }], { overwrite: false });
        assert.ok(p.ok);
        await rename(parent, join(f.dir, 'old-parent'));
        await mkdir(parent);
        assert.equal((await writeOutputs(p.value, [payload('json', '{}')])).ok, false);
        await assert.rejects(stat(join(parent, 'x')));
    }
    finally {
        await f.cleanup();
    }
});
test('exact JSON byte limit writes fully; byte limit plus one leaves no output', async () => {
    const f = await fixture();
    try {
        const l = await loadAnalysisInputs(f.paths);
        assert.ok(l.ok);
        const path = join(f.dir, 'boundary.json');
        const p = await prepareOutputs(l.value, [{ kind: 'json', path }], { overwrite: false });
        assert.ok(p.ok);
        const bytes = new Uint8Array(LIMITS.json);
        bytes.fill(32);
        assert.ok((await writeOutputs(p.value, [{ kind: 'json', utf8: bytes }])).ok);
        assert.equal((await stat(path)).size, LIMITS.json);
    }
    finally {
        await f.cleanup();
    }
});

import { exitCode } from '../src/status.ts';
import { validateOutputPayloads } from '../src/input.ts';
test('HTML and aggregate output byte boundaries fail before any publication with exit 3',async()=>{
 const f=await fixture();try{const l=await loadAnalysisInputs(f.paths);assert.ok(l.ok);const h=join(f.dir,'limit.html');const p=await prepareOutputs(l.value,[{kind:'html',path:h}],{overwrite:false});assert.ok(p.ok);const r=await writeOutputs(p.value,[{kind:'html',utf8:new Uint8Array(LIMITS.html+1)}]);assert.equal(exitCode(r as any),3);await assert.rejects(stat(h));
 const requests=[{kind:'html' as const,path:join(f.dir,'a.html')},{kind:'json' as const,path:join(f.dir,'b.json')},{kind:'json' as const,path:join(f.dir,'c.json')}];const q=await prepareOutputs(l.value,requests,{overwrite:false});assert.ok(q.ok);const payloads=[{kind:'html' as const,utf8:new Uint8Array(LIMITS.html)},{kind:'json' as const,utf8:new Uint8Array(LIMITS.json)},{kind:'json' as const,utf8:new Uint8Array(8*1024*1024)}];assert.ok(validateOutputPayloads(q.value,payloads,0).ok);assert.equal(validateOutputPayloads(q.value,payloads,1).ok,false);payloads[2]!.utf8=new Uint8Array(8*1024*1024+1);assert.equal(exitCode(await writeOutputs(q.value,payloads) as any),3);for(const x of requests)await assert.rejects(stat(x.path));
 }finally{await f.cleanup()}
});

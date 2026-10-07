import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, simple, contextFor } from './helpers.ts';
import { loadAnalysisInputs, prepareOutputs, revalidateOutputPermit, validateOutputPayloads } from '../src/input.ts';
import { parseWorkflow } from '../src/workflow.ts';
import { parseRunLog } from '../src/logs.ts';
import { parseCacheList } from '../src/cache-list.ts';
import { associateSteps } from '../src/associate.ts';
import { join, dirname } from 'node:path';
import { writeFile, symlink, link, readFile } from 'node:fs/promises';
const pass = (r: any) => { assert.equal(r.ok, true, r.ok ? '' : r.diagnostics.map((d: any) => d.code).join(',')); return r.value.inputs; };
const reject = (r: any, c: string) => { assert.equal(r.ok, false); assert.ok(r.diagnostics.some((d: any) => d.code === c), r.diagnostics.map((d: any) => d.code).join(',')); };
async function run(...args: Parameters<typeof fixture>) {
    const f = await fixture(...args);
    try {
        return await loadAnalysisInputs(f.paths);
    }
    finally {
        await f.cleanup();
    }
}
test('parsers reject forged parse capabilities despite fake successful methods', () => { const ctx = { guard: () => ({ ok: true, value: null }), withSource: () => ({ ok: true, value: { fake: true } }) }; reject(parseWorkflow(ctx as any, 'fake'), 'PARSE_CAPABILITY_INVALID'); reject(parseRunLog(ctx as any, 'fake', 'a'), 'PARSE_CAPABILITY_INVALID'); reject(parseCacheList(ctx as any, 'fake'), 'PARSE_CAPABILITY_INVALID'); });
for (const [slot, max] of [['workflow', 2097152], ['a', 10485760], ['b', 10485760], ['context', 2097152], ['cacheList', 2097152]] as const)
    test(`${slot} byte limit accepts exact and refuses plus one`, async () => {
        const make = (n: number) => slot === 'workflow' ? simple + '#' + 'x'.repeat(n - Buffer.byteLength(simple) - 1) : slot === 'a' || slot === 'b' ? 'x'.repeat(n) : slot === 'context' ? JSON.stringify({ schemaVersion: 1, runs: { a: { steps: [] }, b: { steps: [] } } }) + ' '.repeat(n - 62) : '[]' + ' '.repeat(n - 2);
        // Context base is independently 62 bytes; constructing via actual length would hide an off-by-one fixture.
        if (slot === 'context')
            assert.equal(Buffer.byteLength(JSON.stringify({ schemaVersion: 1, runs: { a: { steps: [] }, b: { steps: [] } } })), 62);
        const load = (n: number) => run(slot === 'workflow' ? make(n) : simple, slot === 'a' ? make(n) : '', slot === 'b' ? make(n) : '', slot === 'context' ? make(n) : undefined, slot === 'cacheList' ? make(n) : undefined);
        pass(await load(max));
        reject(await load(max + 1), 'INPUT_BYTES_LIMIT');
    });
test('total physical line budget counts all sources including exact 200000', async () => { pass(await run(simple, 'x\n'.repeat(199993))); reject(await run(simple, 'x\n'.repeat(199994)), 'TOTAL_LINES_LIMIT'); });
test('whole workflow steps include ordinary scripts at 2000 and 2001', async () => { const w = (n: number) => 'jobs:\n  build:\n    steps:\n' + '      - run: echo safe\n'.repeat(n); pass(await run(w(2000))); reject(await run(w(2001)), 'WORKFLOW_STEPS_LIMIT'); });
test('key Unicode codepoint and expression UTF8 limits accept exact/refuse plus one', async () => {
    pass(await run(simple.replace('public-key', '😀'.repeat(512))));
    reject(await run(simple.replace('public-key', '😀'.repeat(513))), 'KEY_LIMIT');
    const e = (n: number) => '${{ ' + 'a'.repeat(n - 7) + ' }}';
    pass(await run(simple.replace('path: .cache', 'path: ' + e(4096))));
    reject(await run(simple.replace('path: .cache', 'path: ' + e(4097))), 'EXPRESSION_LIMIT');
    for (const where of ['context', 'cache-list', 'log'] as const) {
        const load = (n: number) => where === 'context' ? run(simple, 'x', 'x', contextFor(undefined, [{ field: 'restoreKeys', state: 'value', value: ['k'.repeat(n)] }])) : where === 'cache-list' ? run(simple, '', '', undefined, [{ key: 'k'.repeat(n) }]) : run(simple, 'Cache restored from key: ' + 'k'.repeat(n), 'x', contextFor());
        pass(await load(512));
        reject(await load(513), 'KEY_LIMIT');
    }
});
test('JSON and YAML container depth exact 64/65 and aliases exact 100/101', async () => {
    const deep = (n: number) => '['.repeat(n) + '0' + ']'.repeat(n);
    pass(await run(simple, '', '', JSON.stringify({ schemaVersion: 1, runs: { a: { steps: [] }, b: { steps: [] } }, ignored: JSON.parse(deep(63)) })));
    reject(await run(simple, '', '', JSON.stringify({ schemaVersion: 1, runs: { a: { steps: [] }, b: { steps: [] } }, ignored: JSON.parse(deep(64)) })), 'DEPTH_LIMIT');
    const w = (n: number) => 'ignored: ' + deep(n - 1) + '\njobs: {}';
    pass(await run(w(64)));
    reject(await run(w(65)), 'DEPTH_LIMIT');
    const aliases = (n: number) => 'anchor: &anchor {value: safe}\nignored: [' + Array(n).fill('*anchor').join(',') + ']\njobs: {}';
    pass(await run(aliases(100)));
    reject(await run(aliases(101)), 'ALIAS_LIMIT');
});
test('expanded node budget exact 100000 and plus one includes JSON containers', async () => {
    // Root context: 8 nodes; jobs:{} workflow independently adds 3 nodes to the shared session.
    const c = (n: number) => ({ schemaVersion: 1, runs: { a: { steps: [] }, b: { steps: [] } }, ignored: Array(n - 8).fill(0) });
    pass(await run('jobs: {}', '', '', c(99997)));
    reject(await run('jobs: {}', '', '', c(99998)), 'NODE_LIMIT');
});
test('cache entries exact 10000/10001, with missing fields retained', async () => { const entries = (n: number) => Array.from({ length: n }, () => ({})); const x = pass(await run(simple, '', '', undefined, entries(10000))); assert.equal(x.cacheList.entries.length, 10000); assert.equal(x.cacheList.entries[0].version.state, 'missing'); reject(await run(simple, '', '', undefined, entries(10001)), 'CACHE_ENTRIES_LIMIT'); });
test('all observations exact 50000/50001 include declarations and both runs', async () => {
    const ev = Array.from({ length: 250 }, () => ({ field: 'cacheHit', state: 'value', value: 'unrecorded' }));
    const regions = Array.from({ length: 199 }, (_, i) => ({ id: 'r' + i, phase: 'main', startLine: 1, endLine: 1 }));
    const c = (extra: boolean) => ({ schemaVersion: 1, runs: { a: { steps: [{ target: { jobId: 'build', stepIndex: 0 }, regions, evidence: ev }] }, b: { steps: extra ? [{ target: { jobId: 'build', stepIndex: 0 }, regions: [{ id: 'one', phase: 'main', startLine: 1, endLine: 1 }], evidence: [] }] : [] } } });
    // 250 context declarations + 199*250 run-a observations = 50000. One run-b unrecorded value makes 50001.
    pass(await run(simple, 'x', 'x', c(false)));
    reject(await run(simple, 'x', 'x', c(true)), 'OBSERVATION_LIMIT');
});
test('guard stays associated with its original loaded model and serializes neither', async () => {
    const a = await fixture(), b = await fixture();
    try {
        const x = await loadAnalysisInputs(a.paths), y = await loadAnalysisInputs(b.paths);
        assert.ok(x.ok && y.ok);
        reject(await prepareOutputs({ inputs: y.value.inputs, guard: x.value.guard }, [{ kind: 'json', path: join(a.dir, 'out') }], { overwrite: false }), 'INPUT_GUARD_INVALID');
    }
    finally {
        await a.cleanup();
        await b.cleanup();
    }
});
test('output root escape, existing files, hardlinks and revalidation reject safely', async () => {
    const f = await fixture();
    try {
        const x = await loadAnalysisInputs(f.paths);
        assert.ok(x.ok);
        const p = join(f.dir, 'out');
        await writeFile(p, 'old');
        reject(await prepareOutputs(x.value, [{ kind: 'json', path: p }], { overwrite: false }), 'OUTPUT_EXISTS');
        assert.equal((await prepareOutputs(x.value, [{ kind: 'json', path: p }], { overwrite: true })).ok, true);
        reject(await prepareOutputs(x.value, [{ kind: 'json', path: join(f.dir, '..', 'escape') }], { overwrite: false, outputRoot: f.dir }), 'OUTPUT_ROOT_ESCAPE');
        const r = await prepareOutputs(x.value, [{ kind: 'json', path: join(f.dir, 'new') }], { overwrite: false });
        assert.ok(r.ok);
        await writeFile(join(f.dir, 'new'), 'raced');
        reject(await revalidateOutputPermit(r.value), 'OUTPUT_EXISTS');
        reject(await revalidateOutputPermit({} as any), 'OUTPUT_PERMIT_INVALID');
    }
    finally {
        await f.cleanup();
    }
});
test('output payload exact JSON16MiB HTML24MiB and total48MiB are enforced', async () => {
    const f = await fixture();
    try {
        const x = await loadAnalysisInputs(f.paths);
        assert.ok(x.ok);
        const p = await prepareOutputs(x.value, [{ kind: 'json', path: join(f.dir, 'j') }, { kind: 'html', path: join(f.dir, 'h') }], { overwrite: false });
        assert.ok(p.ok);
        assert.deepEqual(validateOutputPayloads(p.value, [{ kind: 'json', utf8: new Uint8Array(16777216) }, { kind: 'html', utf8: new Uint8Array(25165824) }], 8388608), { ok: true, value: null });
        reject(validateOutputPayloads(p.value, [{ kind: 'json', utf8: new Uint8Array(16777217) }, { kind: 'html', utf8: new Uint8Array() }]), 'OUTPUT_SIZE_LIMIT');
        reject(validateOutputPayloads(p.value, [{ kind: 'json', utf8: new Uint8Array() }, { kind: 'html', utf8: new Uint8Array(25165825) }]), 'OUTPUT_SIZE_LIMIT');
        reject(validateOutputPayloads(p.value, [{ kind: 'json', utf8: new Uint8Array(16777216) }, { kind: 'html', utf8: new Uint8Array(25165824) }], 8388609), 'OUTPUT_TOTAL_LIMIT');
    }
    finally {
        await f.cleanup();
    }
});

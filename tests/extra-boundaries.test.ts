import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, simple, contextFor } from './helpers.ts';
import { loadAnalysisInputs, prepareOutputs } from '../src/input.ts';
import { join } from 'node:path';
import { symlink, link, writeFile } from 'node:fs/promises';
async function run(...args: Parameters<typeof fixture>) {
    const f = await fixture(...args);
    try {
        return await loadAnalysisInputs(f.paths);
    }
    finally {
        await f.cleanup();
    }
}
const pass = (r: any) => { assert.ok(r.ok, r.ok ? '' : r.diagnostics.map((d: any) => d.code).join(',')); return r.value.inputs; };
const fail = (r: any, c: string) => { assert.equal(r.ok, false); assert.ok(r.diagnostics.some((d: any) => d.code === c), r.diagnostics.map((d: any) => d.code).join(',')); };
test('excerpt 4096 UTF8 text bytes are preserved and 4097 splits without truncation', async () => {
    for (const [n, count] of [[4096, 1], [4097, 2]]) {
        const x = pass(await run(simple.replace('.cache', 'p'.repeat(n))));
        const es = x.excerpts.filter((e: any) => e.ref.startLine === 7);
        assert.equal(es.length, count);
        assert.equal(es.flatMap((e: any) => e.lines).flatMap((l: any) => l.parts).map((p: any) => p.text).join('').length, n);
        assert.ok(es.every((e: any) => e.lines.reduce((n: number, l: any) => n + l.parts.reduce((n: number, p: any) => n + Buffer.byteLength(p.text), 0), 0) <= 4096));
    }
});
test('excerpt 8 physical lines and 9 lines retain all necessary parts by splitting', async () => {
    for (const n of [8, 9]) {
        const x = pass(await run(simple.replace('path: .cache', 'path: |\n' + '            data\n'.repeat(n))));
        const es = x.excerpts.filter((e: any) => e.ref.startLine === 7);
        assert.ok(es.every((e: any) => e.lines.length <= 8));
        assert.equal(es.flatMap((e: any) => e.lines).filter((l: any) => l.parts.some((p: any) => p.text.trim() === 'data')).length, n);
    }
});
test('total excerpt count exact 20000 then plus one fails whole import', async () => {
    // Workflow has 3 scalar excerpts; context has target/region parts, one boundary excerpt and four JSON endpoint markers (7); each log line adds one key excerpt.
    const log = (n: number) => Array(n).fill('Cache restored from key: public').join('\n');
    const c = (n: number) => contextFor([{ id: 'main', phase: 'main', startLine: 1, endLine: n }]);
    const exact = pass(await run(simple, log(19990), log(1), { schemaVersion: 1, runs: { a: { steps: [{ target: { jobId: 'build', stepIndex: 0 }, regions: [{ id: 'main', phase: 'main', startLine: 1, endLine: 19990 }], evidence: [] }] }, b: { steps: [] } } }));
    assert.equal(exact.excerpts.length, 20000);
    fail(await run(simple, log(19991), '', { schemaVersion: 1, runs: { a: { steps: [{ target: { jobId: 'build', stepIndex: 0 }, regions: [{ id: 'main', phase: 'main', startLine: 1, endLine: 19991 }], evidence: [] }] }, b: { steps: [] } } }), 'EXCERPT_COUNT_LIMIT');
});
test('total safe excerpt UTF8 bytes exact 5MiB then plus one fail', async () => {
    // Scalar/boundary baseline=78; four required JSON markers each cost 11 UTF8 bytes; current baseline=122. 10239*512+390+122=5242880.
    const make = (extra: number) => Array(10239).fill('Cache restored from key: ' + 'k'.repeat(512)).concat('Cache restored from key: ' + 'k'.repeat(390 + extra)).join('\n');
    const c = { schemaVersion: 1, runs: { a: { steps: [{ target: { jobId: 'build', stepIndex: 0 }, regions: [{ id: 'main', phase: 'main', startLine: 1, endLine: 10240 }], evidence: [] }] }, b: { steps: [] } } };
    const x = pass(await run(simple, make(0), '', c));
    const n = x.excerpts.flatMap((e: any) => e.lines).flatMap((l: any) => l.parts).reduce((n: number, p: any) => n + Buffer.byteLength(p.text), 0);
    assert.equal(n, 5242880);
    fail(await run(simple, make(1), '', c), 'EXCERPT_BYTES_LIMIT');
});
test('pagination zero items needs explicit complete scope, counters and user declaration', async () => {
    const c = { schemaVersion: 1, runs: { a: { steps: [] }, b: { steps: [] } }, cacheList: { allPages: true, expectedCount: 0, scope: { repository: 'owner/project', ref: 'refs/heads/main', observedAt: '2026-01-02T03:04:05Z' } } };
    const x = pass(await run(simple, '', '', c, { actions_caches: [], total_count: 0 }));
    assert.equal(x.cacheList.pagination.state, 'complete');
    assert.equal(x.cacheList.pagination.origin, 'user_provided');
    assert.equal(x.cacheList.scope.repository.value, 'owner/project');
    assert.ok(!JSON.stringify(x).includes('eviction'));
    assert.equal(pass(await run(simple, '', '', undefined, [])).cacheList.pagination.state, 'unknown');
    assert.equal(pass(await run(simple, '', '', { ...c, cacheList: { ...c.cacheList, allPages: false } }, [])).cacheList.pagination.state, 'incomplete');
    assert.equal(pass(await run(simple, '', '', c, { actions_caches: [], total_count: 1 })).cacheList.pagination.state, 'conflict');
});
test('REST and gh spellings are format-specific and every optional value retains missing', async () => {
    const rest = pass(await run(simple, '', '', undefined, { actions_caches: [{ id: 5, key: 'x', size_in_bytes: 6, sizeInBytes: 99, created_at: '2026-01-02T03:04:05', createdAt: 'discard', unknown: 'private-unknown' }] }));
    assert.deepEqual(rest.cacheList.entries[0].sizeBytes, { state: 'value', value: 6 });
    assert.equal(rest.cacheList.entries[0].version.state, 'missing');
    assert.ok(!JSON.stringify(rest).includes('private-unknown'));
    const gh = pass(await run(simple, '', '', undefined, [{ id: 5, key: 'x', sizeInBytes: 7, size_in_bytes: 99, lastAccessedAt: '2026-01-02T03:04:05Z' }]));
    assert.deepEqual(gh.cacheList.entries[0].sizeBytes, { state: 'value', value: 7 });
    fail(await run(simple, '', '', undefined, { actions_caches: [{ size_in_bytes: -1 }] }), 'CACHE_ENTRY_SCHEMA_INVALID');
    fail(await run(simple, '', '', undefined, [{ createdAt: 'yesterday' }]), 'CACHE_TIME_INVALID');
});
test('context parents and foreign source injection are rejected without raw refs', async () => {
    fail(await run(simple, 'x', 'x', contextFor([{ id: 'main', phase: 'main', startLine: 1, endLine: 1 }, { id: 'main', phase: 'post', startLine: 1, endLine: 1 }])), 'REGION_ID_DUPLICATE');
    fail(await run(simple, 'x', 'x', contextFor([{ id: 'main', phase: 'main', startLine: 1, endLine: 1, parentRegionId: 'missing' }])), 'REGION_PARENT_INVALID');
    const c = contextFor(undefined, [{ field: 'keyLayout', state: 'value', value: { parts: [{ kind: 'variable', variable: { expression: { state: 'value', value: '${{ runner.os }}' }, resolved: { state: 'value', value: 'Linux' }, kind: 'other', keyStart: 0, keyEnd: 5, refs: [{ sourceId: 'foreign', startLine: 1, endLine: 1 }] } }] } }]);
    const x = pass(await run(simple, 'x', 'x', c));
    assert.ok(!JSON.stringify(x).includes('foreign'));
    const o = x.runs[0].observations.find((o: any) => o.field === 'keyLayout');
    assert.equal(o.value.value.parts[0].variable.refs[0].jsonPointer, '/runs/a/steps/0/evidence/0/value/parts/0/variable');
});
test('output aliases include case variants, leaf symlink and shared hardlink destinations', async () => {
    const f = await fixture();
    try {
        const leaf = join(f.dir, 'leaf');
        try {
            await symlink(f.paths.workflow, leaf, 'file');
        }
        catch (e) {
            throw new Error('SYMLINK_TEST_UNAVAILABLE');
        }
        const x = await loadAnalysisInputs(f.paths);
        assert.ok(x.ok);
        fail(await prepareOutputs(x.value, [{ kind: 'json', path: leaf }], { overwrite: true }), 'OUTPUT_LEAF_LINK');
        if (process.platform === 'win32')
            fail(await prepareOutputs(x.value, [{ kind: 'json', path: f.paths.workflow.toUpperCase() }], { overwrite: true }), 'OUTPUT_INPUT_ALIAS');
        const first = join(f.dir, 'first');
        await writeFile(first, 'public');
        const second = join(f.dir, 'second');
        await link(first, second);
        fail(await prepareOutputs(x.value, [{ kind: 'json', path: first }, { kind: 'html', path: second }], { overwrite: true }), 'OUTPUT_COLLISION');
    }
    finally {
        await f.cleanup();
    }
});

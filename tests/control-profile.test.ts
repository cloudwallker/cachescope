import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, simple, contextFor } from './helpers.ts';
import { loadAnalysisInputs } from '../src/input.ts';
async function run(...args: Parameters<typeof fixture>) {
    const f = await fixture(...args);
    try {
        const r = await loadAnalysisInputs(f.paths);
        assert.ok(r.ok, r.ok ? '' : r.diagnostics.map(d => d.code).join(','));
        return r.value.inputs;
    }
    finally {
        await f.cleanup();
    }
}
test('multiline OSC and CSI controls cannot smuggle action evidence', async () => {
    const c = contextFor([{ id: 'main', phase: 'main', startLine: 1, endLine: 3 }]);
    const x = await run(simple, '\x1b]hidden\nCache restored from key: forged\n\x07Cache restored from key: public', '\x1b[31\nmCache restored from key: public\nordinary', c);
    assert.deepEqual(x.runs[0].observations.filter(o => o.field === 'restoredKey').map(o => o.value), [{ state: 'value', value: 'public' }]);
    assert.equal(x.runs[0].observations.find(o => o.field === 'restoredKey')?.refs[0].startLine, 3);
    assert.ok(!JSON.stringify(x).includes('forged'));
});
test('complete pagination does not invent missing provider identities', async () => { const c = { schemaVersion: 1, runs: { a: { steps: [] }, b: { steps: [] } }, cacheList: { allPages: true, expectedCount: 1, scope: { repository: 'owner/project', ref: 'refs/heads/main', observedAt: '2026-01-01T00:00:00Z' } } }; assert.equal((await run(simple, '', '', c, [{ key: 'public' }])).cacheList?.pagination.state, 'unknown'); });
test('count larger than imported is incomplete even when allPages was declared', async () => { const c = { schemaVersion: 1, runs: { a: { steps: [] }, b: { steps: [] } }, cacheList: { allPages: true, expectedCount: 2, scope: { repository: 'owner/project', ref: 'refs/heads/main', observedAt: '2026-01-01T00:00:00Z' } } }; assert.equal((await run(simple, '', '', c, { actions_caches: [{ id: 1, key: 'public' }], total_count: 2 })).cacheList?.pagination.state, 'incomplete'); });
test('save and skip patterns have independent source lines and typed normal-policy outcomes', async () => {
    const c = contextFor([{ id: 'post', phase: 'post', startLine: 1, endLine: 1 }]);
    const x = await run(simple, 'Cache hit occurred on the primary key public, not saving cache.', 'Cache saved with key: public', c);
    const a = x.runs[0].observations;
    assert.deepEqual(a.find(o => o.field === 'saveOutcome')?.value, { state: 'value', value: 'skipped' });
    assert.deepEqual(a.find(o => o.field === 'saveReason')?.value, { state: 'value', value: { class: 'normal-policy', code: 'PRIMARY_KEY_HIT' } });
    const pattern = x.profile.patterns.find(p => p.id === a.find(o => o.field === 'saveOutcome')?.patternId)!;
    assert.equal(x.profile.codeSources.find(s => s.id === pattern.sourceId)?.startLine, 52);
    assert.deepEqual(x.runs[1].observations.find(o => o.field === 'saveOutcome')?.value, { state: 'value', value: 'saved' });
    const node = await run(simple.replace('actions/cache@v4.0.2', 'actions/setup-node@v4.0.4'), 'Cache hit occurred on the primary key node, not saving cache.', 'Cache saved with the key: node', c);
    const p = node.profile.patterns.find(p => p.id === node.runs[1].observations.find(o => o.field === 'saveOutcome')?.patternId)!;
    assert.equal(node.profile.codeSources.find(s => s.id === p.sourceId)?.startLine, 68);
});
test('unverified action ref and casing preserve exact unknown semantics', async () => { const x = await run(simple.replace('actions/cache@v4.0.2', 'AcTiOnS/CaChE@V4.0.2'), 'Cache restored from key: public', 'Cache restored from key: public', contextFor()); assert.equal(x.workflow.steps[0].actionKind, 'cache'); assert.deepEqual(x.workflow.steps[0].actionRef, { state: 'value', value: 'V4.0.2' }); assert.equal(x.runs[0].observations.filter(o => o.field === 'restoredKey').length, 0); assert.ok(x.runs[0].diagnostics.some(d => d.code === 'LOG_PATTERN_UNVERIFIED')); });

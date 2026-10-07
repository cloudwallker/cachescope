import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, simple, contextFor } from './helpers.ts';
import { loadAnalysisInputs, assertTrustedInputs } from '../src/input.ts';
import { associateSteps } from '../src/associate.ts';
const two = 'jobs:\n  build:\n    steps:\n      - uses: actions/cache@v4.0.2\n      - run: echo safe\n      - id: second\n        uses: actions/cache@v4.0.2\n';
async function load(w: string, a: string, b: string, c?: unknown) {
    const f = await fixture(w, a, b, c);
    try {
        const r = await loadAnalysisInputs(f.paths);
        assert.ok(r.ok, r.ok ? '' : r.diagnostics.map(d => d.code).join(','));
        return r.value.inputs;
    }
    finally {
        await f.cleanup();
    }
}
const region = (name: string, start: number, phase = 'main', parent?: string, complete?: boolean) => ({ id: name, phase, startLine: start, endLine: start, ...(parent ? { parentRegionId: parent } : {}), ...(complete === undefined ? {} : { complete }) });
test('two runs reordered use exact context identity and anonymous workflow steps keep indices', async () => {
    const c = { schemaVersion: 1, runs: { a: { steps: [{ target: { jobId: 'build', stepIndex: 0 }, regions: [region('first', 1)], evidence: [] }, { target: { jobId: 'build', stepIndex: 2 }, regions: [region('second', 2)], evidence: [] }] }, b: { steps: [{ target: { jobId: 'build', stepIndex: 0 }, regions: [region('first', 2)], evidence: [] }, { target: { jobId: 'build', stepIndex: 2 }, regions: [region('second', 1)], evidence: [] }] } } };
    const x = await load(two, 'Cache restored from key: first-a\nCache restored from key: second-a', 'Cache restored from key: second-b\nCache restored from key: first-b', c);
    const before = JSON.stringify(x);
    const result = associateSteps(x);
    assert.ok(result.ok);
    assert.equal(result.value.steps[0].status, 'unique');
    assert.ok(result.value.steps.every(s => s.selected));
    const s = result.value.steps[0];
    assert.equal(x.runs[0].blocks.find(b => b.id === s.runA[0].mainBlockId)?.range.startLine, 1);
    assert.equal(x.runs[1].blocks.find(b => b.id === s.runB[0].mainBlockId)?.range.startLine, 2);
    assert.equal(x.workflow.steps[1].stepIndex, 2);
    assert.equal(x.workflow.steps[0].stepId.state, 'missing');
    assert.equal(JSON.stringify(x), before);
    const selected = associateSteps(x, { step: { kind: 'stepRef', value: x.workflow.steps[0].stepRef as any } });
    assert.ok(selected.ok);
    assert.deepEqual(selected.value.selectedSteps, [x.workflow.steps[0].stepRef]);
    assert.equal(selected.value.steps[1].inScope, false);
});
test('duplicate stepId remains ambiguous, selection cannot manufacture a unique log association', async () => {
    const w = two.replace('      - uses:', '      - id: second\n        uses:');
    const c = { schemaVersion: 1, runs: { a: { steps: [{ target: { jobId: 'build', stepId: 'second' }, regions: [region('main', 1)], evidence: [] }] }, b: { steps: [{ target: { jobId: 'build', stepId: 'second' }, regions: [region('main', 1)], evidence: [] }] } } };
    const x = await load(w, 'x', 'x', c);
    const a = associateSteps(x);
    assert.ok(a.ok);
    assert.ok(a.value.steps.every(s => s.status === 'ambiguous' && s.selected === undefined));
    const b = associateSteps(x, { step: { kind: 'stepId', value: 'second' as any } });
    assert.equal(b.ok, false);
    if (!b.ok)
        assert.equal(b.diagnostics[0].code, 'SELECTION_AMBIGUOUS');
});
test('multiple main candidates never select first; main completeness does not imply post completeness', async () => {
    const x = await load(simple, 'x\ny', 'x\ny', contextFor([region('main', 1, 'main', undefined, true), region('another', 2, 'main')]));
    const a = associateSteps(x);
    assert.ok(a.ok);
    assert.equal(a.value.steps[0].status, 'ambiguous');
    assert.equal(a.value.steps[0].selected, undefined);
    assert.deepEqual(a.value.steps[0].runA.map(c => c.mainStatus), ['ambiguous', 'ambiguous']);
    const y = await load(simple, 'x\ny', 'x\ny', contextFor([region('main', 1, 'main', undefined, true), region('post', 2, 'post', 'main')]));
    const p = y.runs[0].blocks.find(b => b.phase === 'post')!;
    assert.equal(p.completeness.state, 'unknown');
    assert.equal(p.completeness.basis, 'none');
});
test('multiple linked post blocks keep main selected while save is ambiguous', async () => {
    const regions = [region('main', 1), region('p1', 2, 'post', 'main'), region('p2', 3, 'post', 'main')];
    const x = await load(simple, 'x\ny\nz', 'x\ny\nz', contextFor(regions));
    const r = associateSteps(x);
    assert.ok(r.ok);
    const s = r.value.steps[0];
    assert.ok(s.selected);
    assert.equal(s.status, 'ambiguous');
    assert.equal(s.runA[0].mainStatus, 'unique');
    assert.equal(s.runA[0].saveStatus, 'ambiguous');
    assert.equal(s.runA[0].postBlockIds.length, 2);
});
test('explicit save targets link only the named save step and incompatible primary keys conflict', async () => {
    const w = 'jobs:\n  build:\n    steps:\n      - id: restore\n        uses: actions/cache/restore@v4.0.2\n      - id: save\n        uses: actions/cache/save@v4.0.2\n';
    const cs = [{ target: { jobId: 'build', stepId: 'restore' }, regions: [region('main', 1)], evidence: [{ field: 'primaryKey', state: 'value', value: 'primary' }], saveTargets: [{ jobId: 'build', stepId: 'save' }] }, { target: { jobId: 'build', stepId: 'save' }, regions: [region('save', 2, 'save')], evidence: [] }];
    const c = { schemaVersion: 1, runs: { a: { steps: cs }, b: { steps: cs } } };
    const x = await load(w, 'x\nCache saved with key: other', 'x\nCache saved with key: other', c);
    const r = associateSteps(x);
    assert.ok(r.ok);
    const s = r.value.steps[0];
    assert.ok(s.selected);
    assert.equal(s.status, 'conflict');
    assert.deepEqual(s.runA[0].saveStepRefs, [x.workflow.steps[1].stepRef]);
    assert.equal(s.runA[0].saveStatus, 'conflict');
});
test('overlapping targets and action-ref declarations preserve conflict evidence', async () => {
    const c = { schemaVersion: 1, runs: { a: { steps: [{ target: { jobId: 'build', stepIndex: 0 }, regions: [region('first', 1)], evidence: [{ field: 'actionRef', state: 'value', value: 'v5' }] }, { target: { jobId: 'build', stepIndex: 2 }, regions: [region('second', 1)], evidence: [] }] }, b: { steps: [] } } };
    const x = await load(two, 'x', '', c);
    assert.ok(x.context?.diagnostics.some(d => d.code === 'CONTEXT_OVERLAP'));
    assert.ok(x.runs[0].diagnostics.some(d => d.code === 'ACTION_REF_CONFLICT'));
    const r = associateSteps(x);
    assert.ok(r.ok);
    assert.equal(r.value.steps[0].status, 'conflict');
});
test('clones, added free fields and nested replacement never obtain trusted eligibility', async () => { const x = await load(simple, '', ''); const clone = structuredClone(x); assert.equal(assertTrustedInputs(clone).ok, false); assert.equal(assertTrustedInputs({ ...x, free: 'extra' }).ok, false); assert.equal(assertTrustedInputs({ ...x, runs: [{ ...x.runs[0], observations: [] }, x.runs[1]] }).ok, false); assert.deepEqual(assertTrustedInputs(x), { ok: true, value: null }); });
test('pinned workflow SHA and declared execution SHA retain declaration verification', async () => {
    const sha = '0c45773b623bea8c8e75f6c82b208c3cf94ea4f9';
    const c = contextFor(undefined, [{ field: 'executedCommit', state: 'value', value: sha }]);
    const x = await load(simple.replace('v4.0.2', sha), 'Cache restored from key: a', 'Cache restored from key: b', c);
    assert.equal(x.runs[0].blocks[0].verification, 'user_declared');
    assert.equal(x.runs[0].observations.find(o => o.field === 'restoredKey')?.verification, 'user_declared');
    assert.ok(x.runs[0].observations.every(o => o.verification !== 'verified'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, simple, contextFor } from './helpers.ts';
import { loadAnalysisInputs } from '../src/input.ts';
import { associateSteps } from '../src/associate.ts';
async function load(...args: Parameters<typeof fixture>) {
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
test('capture repeating literal text uses capture position rather than global substring search', async () => { const x = await load(simple, 'Cache restored from key: Cache', 'Cache restored from key: Cache', contextFor()); const e = x.excerpts.find(e => e.ref.sourceId === x.runs[0].sourceId && e.lines.some(l => l.parts.some(p => p.text === 'Cache')))!; assert.equal(e.lines[0].parts[0].startColumn, 25); assert.equal(e.lines[0].parts[0].endColumn, 30); });
test('post parent with a different target identity conflicts rather than saving uniquely', async () => {
    const w = 'jobs:\n  build:\n    steps:\n      - id: first\n        uses: actions/cache@v4.0.2\n      - id: second\n        uses: actions/cache@v4.0.2\n';
    const steps = [{ target: { jobId: 'build', stepId: 'first' }, regions: [{ id: 'm', phase: 'main', startLine: 1, endLine: 1 }], evidence: [] }, { target: { jobId: 'build', stepId: 'second' }, regions: [{ id: 'p', phase: 'post', startLine: 2, endLine: 2, parentRegionId: 'm' }], evidence: [] }];
    const x = await load(w, 'x\ny', 'x\ny', { schemaVersion: 1, runs: { a: { steps }, b: { steps } } });
    const r = associateSteps(x);
    assert.ok(r.ok);
    assert.ok(r.value.steps[0].selected);
    assert.equal(r.value.steps[0].status, 'conflict');
    assert.equal(r.value.steps[0].runA[0].saveStatus, 'conflict');
});
test('keyLayout unknown nested structure never becomes shared extension fields', async () => {
    const c = contextFor(undefined, [{ field: 'keyLayout', state: 'value', value: { parts: [{ kind: 'literal', text: { state: 'value', value: 'safe' }, keyStart: 0, keyEnd: 4, free: 'unrelated' }] } }]);
    const f = await fixture(simple, 'x', 'x', c);
    try {
        const r = await loadAnalysisInputs(f.paths);
        assert.equal(r.ok, false);
        if (!r.ok)
            assert.equal(r.diagnostics[0].code, 'FIELD_SCHEMA_INVALID');
    }
    finally {
        await f.cleanup();
    }
});
test('uncovered diagnostic refs have a fixed redacted physical anchor', async () => { const x = await load(simple, 'Cache unknown raw content', 'x', contextFor()); const d = x.runs[0].diagnostics.find(d => d.code === 'LOG_PATTERN_UNVERIFIED')!; assert.ok(x.excerpts.some(e => e.ref.sourceId === d.refs[0].sourceId && e.lines.some(l => l.line === 1 && l.parts.some(p => p.text === '[已遮盖]')))); });
test('YAML expansion counts aliases every time at exact 100000/100001 expanded nodes', async () => {
    const w = (n: number) => 'anchor: &anchor [' + Array(1000).fill('0').join(',') + ']\nignored: [' + Array(98).fill('*anchor').join(',') + ']\npadding: [' + Array(n).fill('0').join(',') + ']\njobs: {}';
    await load(w(795), '', '');
    const f = await fixture(w(796));
    try {
        const r = await loadAnalysisInputs(f.paths);
        assert.equal(r.ok, false);
        if (!r.ok)
            assert.equal(r.diagnostics[0].code, 'NODE_LIMIT');
    }
    finally {
        await f.cleanup();
    }
});

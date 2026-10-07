import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { loadAnalysisInputs } from '../src/input.ts';
test('alias reference budget counts physical references while expansions share node budget', async () => {
    const w = 'base: &b [0]\nmid: &m [*b, *b]\nignored: [' + Array(50).fill('*m').join(',') + ']\njobs: {}';
    const f = await fixture(w);
    try {
        const r = await loadAnalysisInputs(f.paths);
        assert.ok(r.ok, r.ok ? '' : r.diagnostics.map(d => d.code).join(','));
    }
    finally {
        await f.cleanup();
    }
});
test('repeated uncovered statements in overlapping same-target regions keep unique diagnostic identities', async () => {
    const c = { schemaVersion: 1, runs: { a: { steps: [{ target: { jobId: 'build', stepIndex: 0 }, regions: [{ id: 'one', phase: 'main', startLine: 1, endLine: 1 }, { id: 'two', phase: 'main', startLine: 1, endLine: 1 }], evidence: [] }] }, b: { steps: [] } } };
    const f = await fixture(undefined, 'Cache unknown', '', c);
    try {
        const r = await loadAnalysisInputs(f.paths);
        assert.ok(r.ok);
        const ds = r.value.inputs.runs[0].diagnostics;
        assert.equal(new Set(ds.map(d => d.id)).size, ds.length);
    }
    finally {
        await f.cleanup();
    }
});

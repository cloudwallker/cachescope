import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, simple, contextFor } from './helpers.ts';
import { loadAnalysisInputs } from '../src/input.ts';
test('source-slot ordering precedes incomparable physical line numbers in different files', async () => {
    const c = contextFor([{ id: 'main', phase: 'main', startLine: 100, endLine: 100 }], [{ field: 'primaryKey', state: 'value', value: 'declared' }]);
    const f = await fixture(simple, Array(99).fill('ordinary').concat('Cache restored from key: actual').join('\n'), Array(99).fill('ordinary').concat('Cache restored from key: actual').join('\n'), c);
    try {
        const r = await loadAnalysisInputs(f.paths);
        assert.ok(r.ok);
        assert.equal(r.value.inputs.runs[0].observations[0].field, 'restoredKey');
        assert.equal(r.value.inputs.runs[0].observations[0].refs[0].startLine, 100);
    }
    finally {
        await f.cleanup();
    }
});

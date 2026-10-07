import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, simple, contextFor } from './helpers.ts';
import { loadAnalysisInputs } from '../src/input.ts';
test('I1 escaped cache-list and scope text inherit decoded field masking at the loader boundary', async () => {
    const synthetic = ['gh', 'p_', 'SYNTHETIC_ONLY_1234567890'].join('');
    const encoded = Array.from(synthetic).map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    const context = { ...contextFor([], []), cacheList: { scope: { repository: synthetic, ref: synthetic } } };
    const list = [{ key: synthetic, version: synthetic, ref: synthetic }];
    const f = await fixture(simple, '', '', JSON.stringify(context).replaceAll(synthetic, encoded), JSON.stringify(list).replaceAll(synthetic, encoded));
    try {
        const r = await loadAnalysisInputs(f.paths);
        assert.ok(r.ok);
        const x = r.value.inputs;
        assert.equal(x.cacheList!.entries[0].key.state, 'masked');
        assert.equal(x.context!.cacheList!.scope.repository.state, 'masked');
        const target = x.excerpts.filter(e => e.ref.sourceId === x.cacheList!.sourceId || e.ref.jsonPointer?.startsWith('/cacheList/scope/'));
        assert.equal(target.length, 5);
        assert.ok(target.every(e => e.redacted && e.lines.every(l => l.parts.every(p => p.text === '[已遮盖]'))), 'escaped raw scalar must inherit decoded masking');
    }
    finally {
        await f.cleanup();
    }
});

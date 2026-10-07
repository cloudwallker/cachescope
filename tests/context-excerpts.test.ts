import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, simple, contextFor } from './helpers.ts';
import { loadAnalysisInputs } from '../src/input.ts';
test('context mapping and region declaration refs carry necessary scalar parts rather than raw JSON', async () => { const f = await fixture(simple, 'x', 'x', contextFor()); try {
    const r = await loadAnalysisInputs(f.paths);
    assert.ok(r.ok);
    const x = r.value.inputs;
    const cs = x.context!.steps[0];
    const target = x.excerpts.find(e => e.ref.jsonPointer === '/runs/a/steps/0/target' && e.lines.some(l => l.parts.some(p => p.startColumn < p.endColumn)))!;
    assert.ok(target);
    assert.deepEqual(target.lines.flatMap(l => l.parts.map(p => p.text)), ['"build"', '0']);
    const region = x.excerpts.find(e => e.ref.jsonPointer === '/runs/a/steps/0/regions/0' && e.lines.some(l => l.parts.some(p => p.startColumn < p.endColumn)))!;
    assert.ok(region);
    assert.deepEqual(region.lines.flatMap(l => l.parts.map(p => p.text)), ['"main"', '1', '1']);
    for (const ref of [target.ref, region.ref])
        for (const line of [ref.startLine, ref.endLine])
            assert.ok(x.excerpts.some(e => e.ref.jsonPointer === ref.jsonPointer && e.redacted && e.lines.some(l => l.line === line && l.parts.some(p => p.startColumn === p.endColumn && p.text === '[已遮盖]'))));
    assert.ok(!JSON.stringify(x.excerpts).includes('"regions":'));
}
finally {
    await f.cleanup();
} });

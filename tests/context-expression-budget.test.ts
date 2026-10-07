import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, simple, contextFor } from './helpers.ts';
import { loadAnalysisInputs } from '../src/input.ts';
test('context key-layout expressions share the 4096-byte budget including delimiters', async () => { for (const [n, accepted] of [[4096, true], [4097, false]] as const) {
    const expression = '${{ ' + 'a'.repeat(n - 7) + ' }}';
    const c = contextFor(undefined, [{ field: 'keyLayout', state: 'value', value: { parts: [{ kind: 'variable', variable: { expression: { state: 'value', value: expression }, resolved: { state: 'missing' }, kind: 'other', keyStart: 0, keyEnd: 0 } }] } }]);
    const f = await fixture(simple, 'x', 'x', c);
    try {
        const r = await loadAnalysisInputs(f.paths);
        assert.equal(r.ok, accepted);
        if (!r.ok)
            assert.equal(r.diagnostics[0].code, 'EXPRESSION_LIMIT');
    }
    finally {
        await f.cleanup();
    }
} });

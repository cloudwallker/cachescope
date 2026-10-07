import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { loadAnalysisInputs, analyzeInputs } from '../src/index.ts';
import { join } from 'node:path';
test('retained JSON structure references have safe original endpoint anchors without raw object export', async () => {
    const dir = join(process.cwd(), 'fixtures/dynamic-key');
    const x = await loadAnalysisInputs({ workflow: join(dir, 'workflow.yml'), runA: join(dir, 'run-a.txt'), runB: join(dir, 'run-b.txt'), context: join(dir, 'context.json') });
    assert.ok(x.ok);
    const r = analyzeInputs(x.value.inputs);
    assert.ok(r.ok);
    const refs: any[] = [];
    const walk = (v: any): void => { if (!v || typeof v !== 'object')
        return; if (v.jsonPointer !== undefined && v.sourceId && v.startLine)
        refs.push(v); for (const child of Object.values(v))
        walk(child); };
    walk({ ...r.value, profile: null });
    for (const ref of refs)
        for (const line of new Set([ref.startLine, ref.endLine]))
            assert.ok(r.value.excerpts.some(e => e.ref.sourceId === ref.sourceId && e.lines.some(l => l.line === line && l.parts.length)), 'JSON structure endpoint is absent');
    assert.ok(refs.length > 0);
});
test('exact action refs and safe structure endpoints come from original AST even with earlier id and unknown metadata', async () => {
    const w = 'jobs:\n  build:\n    steps:\n      - id: cache\n        uses: actions/cache@v99\n        with:\n          key: public\n          path: .cache\n        name: UNRELATED_PUBLIC_METADATA\n';
    const f = await fixture(w);
    try {
        const x = await loadAnalysisInputs(f.paths);
        assert.ok(x.ok);
        const i = x.value.inputs, s = i.workflow.steps[0]!;
        assert.deepEqual((s as any).actionRefRefs, [{ sourceId: i.sources[0]!.id, startLine: 5, endLine: 5 }]);
        for (const line of [4, 9])
            assert.ok(i.excerpts.some(e => e.lines.some(l => l.line === line && l.parts.some(p => p.text === '[已遮盖]' && p.startColumn === p.endColumn))));
        assert.ok(!JSON.stringify(i).includes('UNRELATED_PUBLIC_METADATA'));
        const r = analyzeInputs(i);
        assert.ok(r.ok);
        const d = r.value.diagnostics.find(d => d.code === 'ACTION_REF_UNVERIFIED')!;
        assert.deepEqual(d.refs, (s as any).actionRefRefs);
    }
    finally {
        await f.cleanup();
    }
});
test('aliased uses preserves both declaration and usage refs and escaped masked representations stay masked', async () => {
    const secret = ['gh', 'p_', 'SYNTHETIC_ONLY_1234567890'].join(''), encoded = Array.from(secret).map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    for (const ref of ['v99', encoded]) {
        const w = 'action: &act "actions/cache@' + ref + '"\njobs:\n  build:\n    steps:\n      - uses: *act\n        with:\n          key: public\n          path: .cache\n';
        const f = await fixture(w);
        try {
            const x = await loadAnalysisInputs(f.paths);
            assert.ok(x.ok);
            const s = x.value.inputs.workflow.steps[0]!;
            assert.ok(Array.isArray(s.actionRefRefs));
            assert.deepEqual(s.actionRefRefs.map((r: any) => r.startLine), [5, 1]);
            if (ref === encoded) {
                assert.equal(s.actionRef.state, 'masked');
                assert.ok(!JSON.stringify(x.value.inputs).includes(encoded));
                assert.ok(!JSON.stringify(x.value.inputs).includes(secret));
            }
        }
        finally {
            await f.cleanup();
        }
    }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, simple, contextFor } from './helpers.ts';
import { loadAnalysisInputs } from '../src/input.ts';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
async function run(...args: Parameters<typeof fixture>) {
    const f = await fixture(...args);
    try {
        return await loadAnalysisInputs(f.paths);
    }
    finally {
        await f.cleanup();
    }
}
const success = (r: any) => { assert.ok(r.ok, r.ok ? '' : r.diagnostics.map((d: any) => d.code).join(',')); return r.value.inputs; };
test('sensitive semantic fields, expressions, URL credentials, PEM and entropy never reach safe model', async () => {
    const secretValues = ['password: short', 'token=small', 'Bearer short-value', 'https://person:short@sample.invalid/cache', 'https://sample.invalid/?token=short', '${{ secrets.SHORT }}', '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----', ['aB9dE3fG', '7hJ1kL5m', 'N8pQ2rS6', 'tU4vW0xYz'].join('')];
    for (const secret of secretValues) {
        const w = simple.replace('public-key', JSON.stringify(secret)).replace('.cache', JSON.stringify(secret));
        const c = contextFor(undefined, [{ field: 'primaryKey', state: 'value', value: secret }, { field: 'resolvedPaths', state: 'value', value: [secret] }]);
        const r = await run(w, 'x', 'x', c);
        const x = success(r);
        const serialized = JSON.stringify(x);
        assert.ok(!serialized.includes(secret), 'synthetic sensitive fragment leaked');
        assert.equal(x.workflow.steps[0].inputs.find((i: any) => i.name === 'key').value.state, 'masked');
        assert.ok(x.runs[0].observations.filter((o: any) => o.field === 'primaryKey' || o.field === 'resolvedPaths').every((o: any) => o.value.state === 'masked'));
    }
});
test('JSON duplicate keys and field shape injection reject safely; arbitrary unknown fields drop', async () => {
    const r = await run(simple, '', '', '{"schemaVersion":1,"schemaVersion":1,"runs":{"a":{"steps":[]},"b":{"steps":[]}}}');
    assert.equal(r.ok, false);
    if (!r.ok)
        assert.equal(r.diagnostics[0].code, 'JSON_DUPLICATE_KEY');
    const c = contextFor(undefined, [{ field: 'lockfileError', state: 'value', value: { path: 'public', reason: 'not-found', free: 'raw' } }]);
    assert.equal((await run(simple, 'x', 'x', c)).ok, false);
    const w = simple.replace('key: public-key', 'resolvedKey: alias');
    const a = await run(w);
    assert.equal(a.ok, false);
    if (!a.ok)
        assert.equal(a.diagnostics[0].code, 'UNKNOWN_FIELD_ALIAS');
});
test('same literal at multiple YAML locations and CR/LF/CRLF preserve original physical refs', async () => {
    const w = 'jobs:\n  build:\n    steps:\n      - uses: actions/cache@v4.0.2\n        with:\n          key: same\n          path: |\n            same\n            ./other\n      - uses: actions/cache@v4.0.2\n        with:\n          key: same\n';
    for (const separator of ['\n', '\r', '\r\n']) {
        const x = success(await run(w.replaceAll('\n', separator)));
        assert.deepEqual(x.workflow.steps.map((s: any) => s.inputs.find((i: any) => i.name === 'key').refs[0].startLine), [6, 12]);
        const p = x.workflow.steps[0].inputs.find((i: any) => i.name === 'path');
        assert.equal(p.refs[0].startLine, 7);
        assert.equal(p.refs[0].endLine, 9);
        assert.deepEqual(p.value, { state: 'value', value: 'same\n./other\n' });
    }
});
test('source JSON Pointer identifies actual node; unknown raw strings and absolute paths are absent', async () => {
    const c = contextFor(undefined, [{ field: 'runnerOS', state: 'value', value: 'Linux' }, { field: 'ref', state: 'value', value: 'refs/heads/main' }, { field: 'defaultBranch', state: 'value', value: 'main' }]);
    const x = success(await run(simple, 'x', 'x', c));
    const o = x.runs[0].observations.find((o: any) => o.field === 'runnerOS');
    assert.equal(o.refs[0].jsonPointer, '/runs/a/steps/0/evidence/0/value');
    assert.equal(o.refs[0].startLine, 23);
    assert.equal(o.origin, 'user_provided');
    assert.equal(o.value.value, 'Linux');
    assert.ok(!JSON.stringify(x).includes(process.cwd()));
});
test('malicious labels and IO exceptions are fixed safe diagnostics', async () => { const r = await loadAnalysisInputs({ workflow: 'missing-token=short.yml', runA: 'none', runB: 'none' }); assert.equal(r.ok, false); const s = JSON.stringify(r); assert.ok(!s.includes('short') && !s.includes('missing-token') && !s.includes(process.cwd())); });
test('lockfileHash text is sanitized before an observation is constructed', async () => { const marker = 'ghp_' + 'Zq7P'.repeat(10); const x = success(await run(simple, 'x', 'x', contextFor(undefined, [{ field: 'lockfileHash', state: 'value', value: marker }]))); assert.equal(x.runs[0].observations.find((o: any) => o.field === 'lockfileHash').value.state, 'masked'); assert.ok(!JSON.stringify(x).includes(marker)); });
test('unknown cache-looking line gets a safe source fragment without inferring save or restore', async () => { const x = success(await run(simple, 'Cache restored??? private free text', 'x', contextFor())); assert.equal(x.runs[0].observations.filter((o: any) => o.field === 'restoredKey').length, 0); const d = x.runs[0].diagnostics.find((d: any) => d.code === 'LOG_PATTERN_UNVERIFIED'); assert.ok(d); assert.ok(x.excerpts.some((e: any) => e.ref.sourceId === d.refs[0].sourceId && e.lines.some((l: any) => l.line === 1 && l.parts.length > 0))); });

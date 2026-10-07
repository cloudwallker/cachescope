import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, simple, contextFor } from './helpers.ts';
import { loadAnalysisInputs } from '../src/input.ts';
import { associateSteps } from '../src/associate.ts';
import { parseJson } from '../src/safety.ts';
async function load(...args: Parameters<typeof fixture>) { const f = await fixture(...args); try {
    return await loadAnalysisInputs(f.paths);
}
finally {
    await f.cleanup();
} }
const pass = (r: Awaited<ReturnType<typeof load>>) => { assert.ok(r.ok, r.ok ? '' : r.diagnostics.map(d => d.code).join(',')); return r.value.inputs; };
const syntheticFragment = ['SYNTHETIC', 'FRAGMENT', '123'].join('_');
const secret = ['gh', 'p_', 'SYNTHETIC_ONLY_1234567890'].join('');
const encoded = Array.from(secret).map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
function absent(x: unknown, fragments: string[]) {
    const visit = (v: unknown): void => {
        if (typeof v === 'string') {
            for (const f of fragments)
                assert.ok(!v.includes(f), 'masked field representation must not survive serialization');
            let decoded: unknown;
            try {
                decoded = JSON.parse(v);
            }
            catch { }
            if (typeof decoded === 'string' && decoded !== v)
                visit(decoded);
        }
        else if (Array.isArray(v))
            v.forEach(visit);
        else if (v && typeof v === 'object')
            Object.values(v).forEach(visit);
    };
    visit(x);
}
test('I1 decoded masked fields suppress multiline and escaped YAML representations', async () => {
    const cases = [
        'path: |\n            password:\n              SYNTHETIC_FRAGMENT_123',
        'path: >\n            password:\n              SYNTHETIC_FRAGMENT_123',
        'path: "' + encoded + '"',
        "path: 'password:\n            SYNTHETIC_FRAGMENT_123'",
    ];
    for (const c of cases) {
        const x = pass(await load(simple.replace('path: .cache', c)));
        const field = x.workflow.steps[0].inputs.find(i => i.name === 'path')!;
        assert.equal(field.value.state, 'masked');
        assert.equal(field.refs[0].startLine, 7);
        absent(x, [secret, syntheticFragment, encoded]);
        assert.ok(x.excerpts.some(e => e.redacted));
    }
});
test('I1 JSON escaped and nested masked fields suppress recoverable tokens and retain exact refs', async () => {
    const c = contextFor(undefined, [{ field: 'primaryKey', state: 'value', value: secret }, { field: 'lockfileError', state: 'value', value: { path: secret, reason: 'not-found', pathBasis: 'error-message' } }]);
    const json = JSON.stringify(c, null, 2).replaceAll(secret, encoded);
    const x = pass(await load(simple, 'ordinary', 'ordinary', json));
    for (const o of x.context!.steps.flatMap(s => s.evidence))
        assert.equal(o.value.state, 'masked');
    absent(x, [secret, encoded]);
    const e = x.excerpts.find(e => e.ref.jsonPointer === '/runs/a/steps/0/evidence/0/value')!;
    assert.ok(e);
    assert.equal(e.lines[0].line, 23);
    assert.ok(e.redacted);
    assert.equal(e.lines[0].parts[0].text, '[已遮盖]');
    // A valid nested field on the same physical JSON line remains independently visible.
    const mixed = contextFor(undefined, [{ field: 'primaryKey', state: 'value', value: secret }, { field: 'runnerOS', state: 'value', value: 'Linux' }]);
    const y = pass(await load(simple, 'ordinary', 'ordinary', JSON.stringify(mixed).replaceAll(secret, encoded)));
    absent(y, [secret, encoded]);
    assert.equal(y.context!.steps[0].evidence[1].value.state, 'value');
    assert.ok(y.excerpts.some(e => e.lines.some(l => l.parts.some(p => p.text === '"Linux"'))));
});
test('I2 complete and embedded runner markers are masked across key and path producers', async () => {
    for (const value of ['***', 'public-***-suffix']) {
        const x = pass(await load(simple.replace('public-key', JSON.stringify(value)).replace('.cache', JSON.stringify(value)), 'Cache restored from key: ' + value, 'Cache restored from key: public', contextFor(undefined, [{ field: 'resolvedPaths', state: 'value', value: [value] }, { field: 'restoreKeys', state: 'value', value: [value] }]), [{ key: value }]));
        assert.equal(x.runs[0].observations.find(o => o.field === 'restoredKey')!.value.state, 'masked');
        assert.equal(x.workflow.steps[0].inputs.find(i => i.name === 'key')!.value.state, 'masked');
        assert.equal(x.workflow.steps[0].inputs.find(i => i.name === 'path')!.value.state, 'masked');
        assert.ok(x.context!.steps.flatMap(s => s.evidence).every(o => o.value.state === 'masked'));
        assert.equal(x.cacheList!.entries[0].key.state, 'masked');
        assert.ok(x.excerpts.filter(e => e.ref.sourceId === x.runs[0].sourceId).every(e => e.redacted));
    }
    const normal = pass(await load(simple, 'Cache restored from key: public', 'ordinary', contextFor(undefined, [{ field: 'primaryKey', state: 'value', value: '' }, { field: 'resolvedPaths', state: 'missing' }])));
    assert.equal(normal.runs[0].observations.find(o => o.field === 'restoredKey')!.value.state, 'value');
    assert.equal(normal.context!.steps[0].evidence[0].value.state, 'empty');
    assert.equal(normal.context!.steps[0].evidence[1].value.state, 'missing');
});
test('I3 strict parser and loader reject object and array trailing commas while preserving normal indexes', async () => {
    for (const text of ['{"a":1,}', '[1,]', '{"a":[0,]}', '[{"a":0,}]'])
        assert.throws(() => parseJson(text, () => { }), e => e instanceof Error && e.message === 'JSON_INVALID');
    for (const text of ['{}', '[]', '{"a":[{},[],0]}'])
        assert.deepEqual(parseJson(text, () => { }).value, JSON.parse(text));
    const indexed = parseJson('{"a":[0,1]}', () => { });
    assert.deepEqual(indexed.nodes.get('/a/1'), { start: 8, end: 9 });
    for (const c of ['{"schemaVersion":1,"runs":{"a":{"steps":[]},"b":{"steps":[]}},}', '{"schemaVersion":1,"runs":{"a":{"steps":[{},]},"b":{"steps":[]}}}']) {
        const r = await load(simple, '', '', c);
        assert.ok(!r.ok);
        assert.ok(r.diagnostics.some(d => d.code === 'JSON_INVALID' && d.category === 'invalid'));
    }
    const list = await load(simple, '', '', undefined, '[{},]');
    assert.ok(!list.ok);
    assert.ok(list.diagnostics.some(d => d.code === 'JSON_INVALID'));
    assert.ok((await load(simple, '', '', contextFor([], []), [])).ok);
});
test('I4 install evidence contains only physical standalone command tokens and rejects ambiguous scalar maps', async () => {
    const w = 'jobs:\n  build:\n    steps:\n      - run: |\n          npm ci\n          echo UNRELATED_SCRIPT_FRAGMENT\n';
    const x = pass(await load(w));
    assert.equal(x.workflow.installSteps.length, 1);
    assert.deepEqual(x.workflow.installSteps[0].range, { sourceId: x.sources[0].id, startLine: 5, endLine: 5 });
    const ps = x.excerpts.flatMap(e => e.lines.flatMap(l => l.parts.map(p => ({ line: l.line, ...p }))));
    assert.ok(ps.some(p => p.line === 5 && p.startColumn === 10 && p.endColumn === 16 && p.text === 'npm ci'));
    absent(x, ['UNRELATED_SCRIPT_FRAGMENT']);
    for (const eol of ['\r\n', '\r']) {
        const y = pass(await load(w.replaceAll('\n', eol)));
        assert.equal(y.workflow.installSteps[0].range.startLine, 5);
        assert.ok(y.excerpts.some(e => e.lines.some(l => l.line === 5 && l.parts.some(p => p.startColumn === 10 && p.endColumn === 16 && p.text === 'npm ci'))));
        absent(y, ['UNRELATED_SCRIPT_FRAGMENT']);
    }
    for (const run of ['>\n          npm\n          ci', '"npm\\x20ci"', '*cmd']) {
        const pre = run === '*cmd' ? 'cmd: &cmd "npm ci"\n' : '';
        const y = pass(await load(pre + 'jobs:\n  build:\n    steps:\n      - run: ' + run + '\n'));
        assert.equal(y.workflow.installSteps.length, 0);
    }
    for (const run of ['npm ci', "'yarn install'", '"pnpm install"'])
        assert.equal(pass(await load('jobs:\n  build:\n    steps:\n      - run: ' + run + '\n')).workflow.installSteps.length, 1);
});
test('I5 covered action identity contradictions preserve both sources and block selection', async () => {
    const w = simple.replace('      - uses:', '      - id: cache\n        uses:');
    for (const head of ['actions/cache@v9', 'actions/setup-node@v4.0.2', 'actions/cache@V4.0.2']) {
        const log = ['##[group]Run ' + head, 'with:', '  key: public', '##[endgroup]', 'ordinary'].join('\n');
        const x = pass(await load(w, log, log, contextFor([{ id: 'main', phase: 'main', startLine: 1, endLine: 5 }])));
        const d = x.runs[0].diagnostics.find(d => d.code === 'ACTION_REF_CONFLICT')!;
        assert.ok(d);
        assert.equal(d.category, 'conflict');
        assert.ok(d.refs.some(r => r.sourceId === x.sources[0].id && r.startLine === 5 && r.endLine === 5));
        assert.ok(d.refs.some(r => r.sourceId === x.runs[0].sourceId && r.startLine === 1));
        const a = associateSteps(x);
        assert.ok(a.ok);
        assert.equal(a.value.steps[0].runA[0].mainStatus, 'conflict');
        assert.equal(a.value.steps[0].status, 'conflict');
        assert.ok(!a.value.steps[0].selected);
        const s = associateSteps(x, { step: { kind: 'stepId', value: 'cache' as any } });
        assert.ok(s.ok);
        assert.ok(!s.value.steps[0].selected);
    }
    for (const head of ['actions/CACHE@v4.0.2', 'unknown/action@v9', 'not-an-action']) {
        const log = ['##[group]Run ' + head, 'with:', '  key: public', '##[endgroup]', 'ordinary'].join('\n');
        const x = pass(await load(simple, log, log, contextFor([{ id: 'main', phase: 'main', startLine: 1, endLine: 5 }])));
        assert.ok(!x.runs[0].diagnostics.some(d => d.category === 'conflict'));
    }
});

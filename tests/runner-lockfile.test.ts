import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { loadAnalysisInputs } from '../src/input.ts';
import { associateSteps } from '../src/associate.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const sha = '0a44ba7841725637a19e28fa30b79a866c81b0a6';
const wf = 'jobs:\n  build:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          cache: npm\n          cache-dependency-path: package-lock.json\n';
const download = `Download action repository 'actions/setup-node@v4' (SHA:${sha})`;
const error = '##[error]Some specified paths were not resolved, unable to cache dependencies.';
const header = ['##[group]Run actions/setup-node@v4', 'with:', '  cache-dependency-path: package-lock.json', '##[endgroup]'];
for (const kind of ['restore', 'save'])
    test('runner download repository and header subpath independently bind cache/' + kind, async () => {
        const commit = '0c45773b623bea8c8e75f6c82b208c3cf94ea4f9';
        const log = [`Download action repository 'actions/cache@v4' (SHA:${commit})`, `##[group]Run actions/cache/${kind}@v4`, 'with:', '  key: public', '  path: .cache', '##[endgroup]', kind === 'restore' ? 'Cache restored from key: public' : 'Cache saved with key: public'].join('\n');
        const step = { target: { jobId: 'build', stepIndex: 0 }, regions: [{ id: 'main', phase: kind === 'save' ? 'save' : 'main', startLine: 2, endLine: 7 }], evidence: [{ field: 'executedCommit', state: 'value', value: commit, logRanges: [{ startLine: 1, endLine: 1 }] }] };
        const f = await fixture(wf.replace('actions/setup-node@v4', 'actions/cache/' + kind + '@v4'), log, log, { schemaVersion: 1, runs: { a: { steps: [step] }, b: { steps: [step] } } });
        try {
            const r = await loadAnalysisInputs(f.paths);
            assert.ok(r.ok);
            const o = r.value.inputs.runs[0].observations.find(o => o.field === (kind === 'restore' ? 'restoredKey' : 'saveOutcome'))!;
            assert.ok(o);
            assert.equal(o.verification, 'verified');
            assert.equal(r.value.inputs.runs[0].blocks[0].completeness.state, 'unknown');
        }
        finally {
            await f.cleanup();
        }
    });
async function run(lines: string[], start = 2, ranges = [{ startLine: 1, endLine: 1 }]) {
    const region = { id: 'main', phase: 'main', startLine: start, endLine: lines.length };
    const step = { target: { jobId: 'build', stepIndex: 0 }, regions: [region], evidence: [{ field: 'executedCommit', state: 'value', value: sha, logRanges: ranges }] };
    const f = await fixture(wf, lines.join('\n'), lines.join('\n'), { schemaVersion: 1, runs: { a: { steps: [step] }, b: { steps: [step] } } });
    try {
        const r = await loadAnalysisInputs(f.paths);
        assert.ok(r.ok, r.ok ? '' : r.diagnostics.map(d => d.code).join(','));
        return r.value.inputs;
    }
    finally {
        await f.cleanup();
    }
}
test('fixed runner download plus independent same-block actual input yields verified not-resolved with full provenance', async () => {
    const x = await run([download, ...header, error]);
    const o = x.runs[0].observations.find(o => o.field === 'lockfileError')!;
    assert.ok(o);
    assert.equal(o.verification, 'verified');
    assert.equal(o.origin, 'log');
    assert.deepEqual(o.value, { state: 'value', value: { path: 'package-lock.json', reason: 'not-resolved', pathBasis: 'action-input' } });
    assert.deepEqual(o.refs.filter(r => r.sourceId === x.runs[0].sourceId).map(r => r.startLine), [6, 2, 3, 4, 5, 1]);
    assert.equal(x.runs[0].blocks[0].completeness.state, 'unknown');
    assert.equal(x.runs[0].observations.find(o => o.origin === 'user_provided' && o.field === 'executedCommit')?.verification, 'user_declared');
    const actual = x.runs[0].observations.find(o => o.origin === 'log' && o.field === 'executedCommit')!;
    assert.equal(actual.verification, 'verified');
    assert.equal(actual.refs[0].startLine, 1);
    assert.ok(actual.refs.some(r => r.jsonPointer === '/runs/a/steps/0/evidence/0/logRanges/0'));
    const a = associateSteps(x);
    assert.ok(a.ok);
    assert.equal(a.value.steps[0].runA[0].basis, 'context-range');
    assert.ok(!x.runs.flatMap(r => r.observations).some(o => String(o.field) === 'dependencyPathInput'));
});
test('handwritten fixed runner and lockfile fixture verifies source hashes, captures and independent context refs', async () => {
    const root = join(process.cwd(), 'fixtures/import-official-lockfile');
    const expected = JSON.parse(await readFile(join(root, 'expected.json'), 'utf8'));
    const r = await loadAnalysisInputs({ workflow: join(root, 'workflow.yml'), runA: join(root, 'run-a.txt'), runB: join(root, 'run-b.txt'), context: join(root, 'context.json') });
    assert.ok(r.ok);
    const x = r.value.inputs;
    for (const [i, run] of x.runs.entries()) {
        const o = run.observations.find(o => o.field === 'lockfileError')!;
        assert.ok(o);
        for (const k of ['field', 'origin', 'verification', 'status', 'value'])
            assert.deepEqual(o[k as keyof typeof o], expected[k]);
        assert.deepEqual(o.refs.filter(r => r.sourceId === run.sourceId).map(r => r.startLine), expected.logLines);
        const declaration = o.refs.find(r => r.jsonPointer?.endsWith('/logRanges/0'))!;
        const want = i === 0 ? expected.aDeclaration : expected.bDeclaration;
        for (const k of Object.keys(want))
            assert.equal(declaration[k as keyof typeof declaration], want[k]);
        const p = x.profile.patterns.find(p => p.id === o.patternId)!;
        assert.ok(p.fixtureIds.includes('fixture:node-lockfile-not-resolved'));
        for (const wanted of [expected.errorSource, expected.downloadSource, expected.headerSource])
            assert.ok(x.profile.codeSources.some(s => Object.keys(wanted).every(k => s[k as keyof typeof s] === wanted[k])));
        for (const wanted of [expected.pathCapture, expected.shaCapture]) {
            const parts = x.excerpts.filter(e => e.ref.sourceId === run.sourceId).flatMap(e => e.lines.filter(l => l.line === wanted.line).flatMap(l => l.parts));
            assert.ok(parts.some(p => p.startColumn === wanted.startColumn && p.endColumn === wanted.endColumn && p.text === wanted.text));
        }
    }
});
for (const [name, lines, start, ranges] of [
    ['missing input', [download, header[0], header[1], header[3], error], 2],
    ['masked input', [download, header[0], header[1], '  cache-dependency-path: ***', header[3], error], 2],
    ['duplicate input', [download, ...header.slice(0, 3), header[2], header[3], error], 2],
    ['conflict input', [download, ...header.slice(0, 3), '  cache-dependency-path: other.json', header[3], error], 2],
    ['wrong block', [download, '##[group]Run actions/cache@v4', ...header.slice(1), error], 2],
    ['unclosed header', [download, ...header.slice(0, 3), error], 2],
    ['forged error path', [download, ...header, error + ' package-lock.json'], 2],
    ['unknown SHA', [download.replace(sha, '1'.repeat(40)), ...header, error], 2],
    ['conflicting SHA', [download, download.replace(sha, '1'.repeat(40)), ...header, error], 3, [{ startLine: 1, endLine: 2 }]],
    ['download inside main', [download, ...header, error], 1],
    ['tag without download', ['ordinary', ...header, error], 2],
    ['wrong download ref', [download.replace('@v4', '@v3'), ...header, error], 2],
    ['multiline input', [download, ...header.slice(0, 3), 'other.json', header[3], error], 2]
] as [
    string,
    string[],
    number,
    {
        startLine: number;
        endLine: number;
    }[]?
][])
    test('closed runner evidence rejects ' + name, async () => { const x = await run(lines, start, ranges); assert.ok(!x.runs[0].observations.some(o => o.field === 'lockfileError' && o.verification === 'verified' && o.value.state === 'value')); });

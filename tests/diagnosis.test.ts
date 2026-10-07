import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import * as api from '../src/index.ts';
import type { Report, AnalysisInputs } from '../src/model.ts';
import { fixture } from './helpers.ts';
const ids = ['dynamic-key', 'lockfile-path', 'path-change', 'restore-only', 'package-cache'];
async function loaded(name: string) { const dir = join(process.cwd(), 'fixtures', name); const r = await api.loadAnalysisInputs({ workflow: join(dir, 'workflow.yml'), runA: join(dir, 'run-a.txt'), runB: join(dir, 'run-b.txt'), context: join(dir, 'context.json') }); assert.ok(r.ok, r.ok ? '' : r.diagnostics.map(d => d.code).join(',')); return { inputs: r.value.inputs, expected: JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8')) }; }
function analyze(inputs: AnalysisInputs): Report { assert.equal(typeof (api as any).analyzeInputs, 'function', 'Task 2 analysis API must process genuine loader inputs'); const r = (api as any).analyzeInputs(inputs); assert.ok(r.ok, r.ok ? '' : r.diagnostics.map((d: any) => d.code).join(',')); return r.value; }
for (const name of ids)
    for (const variant of ['', '/insufficient'])
        test(name + variant + ' preserves independently expected facts and uncertainty', async () => {
            const { inputs, expected } = await loaded(name + variant);
            const r = analyze(inputs);
            assert.equal(r.schemaVersion, 1);
            assert.equal(r.comparisons.length, 5);
            for (const want of expected.findings) {
                const f = r.findings.find(f => f.code === want.code);
                assert.ok(f, 'missing ' + want.code);
                assert.equal(f.kind, want.kind);
                assert.equal(f.certainty, want.certainty);
                assert.equal(f.message.code, want.messageCode);
            }
            for (const [field, values] of Object.entries(expected.fields) as [
                string,
                [
                    unknown,
                    unknown
                ]
            ][]) {
                const comparison = r.comparisons.find(c => c.field === field)!;
                for (const [side, value] of [[comparison.a, values[0]], [comparison.b, values[1]]] as const)
                    if (value === null)
                        assert.equal(side.values.length, 0);
                    else
                        assert.ok(side.values.some(o => o.value.state === 'value' && JSON.stringify(o.value.value) === JSON.stringify(value)));
            }
            for (const runId of expected.runIds) {
                assert.ok(r.comparisons.every(c => (runId === 'a' ? c.a : c.b).runId === runId));
                const sa = r.associations.steps[0]!;
                for (const candidate of runId === 'a' ? sa.runA : sa.runB)
                    assert.equal(inputs.runs.find(run => run.runId === runId)!.blocks.find(b => b.id === candidate.mainBlockId)!.range.startLine, expected.mainStartLine);
            }
            for (const code of expected.missingEvidence)
                assert.ok(r.findings.some(f => f.missingEvidence.some(m => m.code === code)), code);
            assert.equal((api as any).exitCode(r), expected.exitCode);
            assert.ok(r.comparisons.every(c => c.a.basis === expected.comparisonBasis || c.a.basis === 'missing'));
            for (const s of r.suggestions) {
                assert.equal(parseDocument(s.yaml).errors.length, 0);
                assert.ok(s.placeholders.length);
                assert.ok(s.placeholders.every(p => s.yaml.includes(p.name)));
            }
            assert.ok(r.suggestions.some(s => s.yaml.includes(expected.placeholder)));
            assert.deepEqual((api as any).analyzeInputs(inputs).value, r);
            assert.ok(!JSON.stringify(r).includes('PRIVATE_CAPABILITY'));
        });
for (const kind of ['values', 'action-ref'])
    test('conflict ' + kind + ' retains evidence and blocks stronger conclusions', async () => { const { inputs, expected } = await loaded('dynamic-key/conflict-' + kind); const r = analyze(inputs); assert.equal(r.comparisons.find(c => c.field === 'primaryKey')!.state, expected.comparisonState); assert.equal(r.associations.steps[0]!.status, expected.associationStatus); assert.ok(!r.findings.some(f => f.code === 'DATE_SEGMENT_CHANGED')); assert.equal((api as any).exitCode(r), 2); assert.ok(r.comparisons[0]!.a.values.length >= 2 || r.associations.steps[0]!.status === 'conflict'); });
for (const name of ['restore-only', 'lockfile-path'])
    test(name + ' official statement matches handwritten capture/source expectations', async () => {
        const { inputs } = await loaded(name);
        const r = analyze(inputs);
        const e = JSON.parse(await readFile(join(process.cwd(), 'fixtures', name, 'official-expected.json'), 'utf8'));
        for (const runId of e.runIds) {
            const o = r.observations.find(o => o.field === e.field && o.runId === runId && o.origin === 'log')!;
            assert.ok(o);
            assert.deepEqual(o.value, { state: 'value', value: e.value });
            assert.equal(o.verification, e.verification);
            assert.ok(r.profile.codeSources.some(s => Object.entries(e.source).every(([k, v]) => (s as any)[k] === v)));
            if (e.logLines)
                assert.deepEqual(o.refs.filter(q => inputs.sources.find(s => s.id === q.sourceId)?.kind === 'log').map(q => q.startLine), e.logLines);
            else
                assert.ok(r.excerpts.some(x => x.ref.sourceId === o.refs[0]!.sourceId && x.lines.some(l => l.line === e.line && l.parts.some(p => p.startColumn === e.startColumn && p.endColumn === e.endColumn && p.text === e.value))));
        }
    });
test('analysis refuses clones and scope selection keeps only the selected step', async () => { const { inputs } = await loaded('dynamic-key'); analyze(inputs); assert.ok(!(api as any).analyzeInputs(JSON.parse(JSON.stringify(inputs))).ok); const r = (api as any).analyzeInputs(inputs, { step: { kind: 'stepId', value: 'cache' } }); assert.ok(r.ok); assert.equal(r.value.steps.length, 1); assert.equal(r.value.associations.steps.length, 1); });
async function changed(name: string, edit: (c: any, w: string, l: string) => {
    c: any;
    w?: string;
    l?: string;
}) {
    const d = join(process.cwd(), 'fixtures', name);
    const c = JSON.parse(await readFile(join(d, 'context.json'), 'utf8')), w = await readFile(join(d, 'workflow.yml'), 'utf8'), l = await readFile(join(d, 'run-a.txt'), 'utf8');
    const x = edit(c, w, l), f = await fixture(x.w ?? w, x.l ?? l, x.l ?? l, x.c);
    try {
        const r = await api.loadAnalysisInputs(f.paths);
        assert.ok(r.ok, r.ok ? '' : r.diagnostics.map(d => d.code).join(','));
        return analyze(r.value.inputs);
    }
    finally {
        await f.cleanup();
    }
}
test('package cache declaration contradictory to explicit manager cannot confirm object', async () => {
    const r = await changed('package-cache', c => {
        for (const run of ['a', 'b'])
            c.runs[run].steps[0].evidence.push({ field: 'packageManager', state: 'value', value: 'pnpm' });
        return { c };
    });
    assert.ok(!r.findings.some(f => f.code === 'PACKAGE_CACHE_OBJECT'));
    assert.equal(r.findings.find(f => f.code === 'PACKAGE_CACHE_PENDING')!.certainty, 'conflict');
});
test('normal-policy skip in a declared complete post remains pending and never a save failure', async () => {
    const r = await changed('path-change', (c, w, l) => {
        for (const run of ['a', 'b'])
            c.runs[run].steps[0].regions.push({ id: 'post', phase: 'post', startLine: 7, endLine: 7, parentRegionId: 'main', complete: true });
        return { c, l: l + 'Cache hit occurred on the primary key public, not saving cache.\n' };
    });
    assert.ok(r.findings.some(f => f.code === 'SAVE_SKIPPED_NORMAL_POLICY' && f.kind === 'fact'));
    assert.ok(r.findings.some(f => f.code === 'SAVE_OUTCOME_PENDING' && f.missingEvidence.some(m => m.code === 'POST_BOUNDARY')));
    assert.ok(!r.findings.some(f => f.code === 'SAVE_NOT_COMPLETED' && f.certainty === 'confirmed'));
    assert.equal(api.exitCode(r), 2);
});
test('date facts need exact layouts, variable resolution, equal hash and covered ref', async () => {
    for (const edit of [(c: any) => { c.runs.a.steps[0].evidence.find((e: any) => e.field === 'lockfileHash').value = 'other'; }, (c: any) => { c.runs.a.steps[0].evidence.find((e: any) => e.field === 'keyLayout').value.parts[0].keyStart = 1; }, (c: any) => { c.runs.a.steps[0].evidence.find((e: any) => e.field === 'keyLayout').value.parts[1].variable.resolved = { state: 'missing' }; }]) {
        const r = await changed('dynamic-key', c => { edit(c); return { c }; });
        assert.ok(!r.findings.some(f => f.code === 'DATE_SEGMENT_CHANGED'));
        assert.ok(r.findings.some(f => f.code === 'DYNAMIC_KEY_PENDING'));
    }
    const r = await changed('dynamic-key', (c, w, l) => ({ c, w: w.replaceAll('v4.0.2', 'v99'), l: l.replaceAll('v4.0.2', 'v99') }));
    assert.ok(!r.findings.some(f => f.code === 'DATE_SEGMENT_CHANGED'));
    assert.equal(api.exitCode(r), 2);
});
test('only YAML date expression is candidate, absent actual key stays unknown, masks never compare', async () => {
    const candidate = await changed('dynamic-key', c => {
        for (const run of ['a', 'b'])
            c.runs[run].steps[0].evidence = c.runs[run].steps[0].evidence.filter((e: any) => !['primaryKey', 'keyLayout', 'lockfileHash'].includes(e.field));
        return { c };
    });
    assert.equal(candidate.findings.find(f => f.code === 'DYNAMIC_KEY_PENDING')!.certainty, 'candidate');
    const absent = await changed('dynamic-key', c => {
        for (const run of ['a', 'b'])
            c.runs[run].steps[0].evidence = c.runs[run].steps[0].evidence.filter((e: any) => e.field !== 'primaryKey');
        return { c };
    });
    assert.equal(absent.findings.find(f => f.code === 'DYNAMIC_KEY_PENDING')!.certainty, 'unknown');
    const masked = await changed('dynamic-key', c => { c.runs.a.steps[0].evidence.find((e: any) => e.field === 'primaryKey').value = '***'; return { c }; });
    assert.equal(masked.comparisons.find(c => c.field === 'primaryKey')!.state, 'unknown');
    assert.ok(!masked.findings.some(f => f.code === 'KEY_DIFFERENT' || f.code === 'DATE_SEGMENT_CHANGED'));
});
test('restore key order is preserved, resolved path set order is irrelevant, Unicode differences use codepoints', async () => { const r = await changed('path-change', c => { const e = (run: string, field: string) => c.runs[run].steps[0].evidence.find((x: any) => x.field === field); e('a', 'restoreKeys').value = ['x', 'y']; e('b', 'restoreKeys').value = ['y', 'x']; e('a', 'resolvedPaths').value = ['x', 'y', 'x']; e('b', 'resolvedPaths').value = ['y', 'x']; e('a', 'primaryKey').value = '😀a-tail'; e('b', 'primaryKey').value = '😀b-tail'; return { c }; }); assert.equal(r.comparisons.find(c => c.field === 'restoreKeys')!.state, 'different'); assert.deepEqual(r.comparisons.find(c => c.field === 'restoreKeys')!.differences, []); assert.equal(r.comparisons.find(c => c.field === 'resolvedPaths')!.state, 'same'); assert.deepEqual(r.comparisons.find(c => c.field === 'primaryKey')!.differences, [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]); });
test('status policy projections preserve closure and implement 3 > 2 > 1 > 0 separately from full cases', async () => { const { inputs } = await loaded('lockfile-path'), report = analyze(inputs), dynamic = analyze((await loaded('dynamic-key')).inputs); assert.equal(api.exitCode(report), 2); const project = (base: Report, kind: 'fact' | 'problem'): Report => { const findings = base.findings.filter(f => f.certainty === 'confirmed' && f.kind === kind), ids = new Set(findings.map(f => f.id)); const suggestions = base.suggestions.map(s => ({ ...s, findingIds: s.findingIds.filter(x => ids.has(x)) })).filter(s => s.findingIds.length); return { ...base, findings, suggestions, diagnostics: [], stepViews: base.stepViews.map(s => ({ ...s, findingIds: s.findingIds.filter(x => ids.has(x)), diagnosticIds: [] })) }; }; const problem = project(report, 'problem'), fact = project(dynamic, 'fact'); assert.ok(problem.findings.length > 0 && fact.findings.length > 0); assert.equal(api.exitCode(problem), 1); assert.equal(api.exitCode(fact), 0); assert.equal(api.exitCode(report), 2); const invalid = api.analyzeInputs(JSON.parse(JSON.stringify(inputs))); assert.ok(!invalid.ok); assert.equal(api.exitCode(invalid), 3); assert.equal(api.exitCode({ ...report, diagnostics: invalid.diagnostics }), 3); });
test('incomplete same-key cache list never chooses a version, infers eviction or complete hit', async () => {
    const d = join(process.cwd(), 'fixtures/path-change'), w = await readFile(join(d, 'workflow.yml'), 'utf8'), l = await readFile(join(d, 'run-a.txt'), 'utf8'), c = JSON.parse(await readFile(join(d, 'context.json'), 'utf8'));
    for (const r of ['a', 'b'])
        c.runs[r].steps[0].evidence = c.runs[r].steps[0].evidence.filter((e: any) => e.field !== 'cacheVersion');
    const f = await fixture(w, l, l, c, { total_count: 3, actions_caches: [{ id: 1, key: 'public', version: 'v-one', ref: 'refs/heads/main' }, { id: 2, key: 'public', version: 'v-two', ref: 'refs/heads/main' }] });
    try {
        const x = await api.loadAnalysisInputs(f.paths);
        assert.ok(x.ok);
        const r = analyze(x.value.inputs);
        assert.equal(r.cacheList!.entries.length, 2);
        assert.equal(r.cacheList!.pagination.state, 'incomplete');
        assert.ok(!r.findings.some(f => f.code === 'CACHE_VERSION_DIFFERENT'));
        assert.ok(r.findings.some(f => f.code === 'CACHE_VERSION_PENDING'));
        assert.ok(!r.observations.some(o => o.field === 'cacheVersion'));
        assert.equal(api.exitCode(r), 2);
    }
    finally {
        await f.cleanup();
    }
});
test('I01 version difference is independent of equal keys and equal or absent paths', async () => {
    for (const absentPaths of [false, true]) {
        const r = await changed('path-change', c => {
            for (const run of ['a', 'b']) {
                const evidence = c.runs[run].steps[0].evidence;
                if (absentPaths)
                    c.runs[run].steps[0].evidence = evidence.filter((e: any) => e.field !== 'resolvedPaths');
                else
                    evidence.find((e: any) => e.field === 'resolvedPaths').value = ['.cache/shared'];
            }
            return { c };
        });
        assert.equal(r.comparisons.find(c => c.field === 'primaryKey')!.state, 'same');
        assert.equal(r.comparisons.find(c => c.field === 'resolvedPaths')!.state, absentPaths ? 'unknown' : 'same');
        assert.ok(!r.findings.some(f => f.code === 'RESOLVED_PATH_CHANGED'));
        const version = r.findings.find(f => f.code === 'CACHE_VERSION_DIFFERENT')!;
        assert.ok(version, 'independent version difference must be retained');
        assert.equal(version.kind, 'fact');
        assert.equal(version.certainty, 'confirmed');
        assert.equal(version.message.code, 'CACHE_VERSION_DIFFERENT_USER_DECLARED');
        assert.equal(version.observationIds.length, 2);
        assert.ok(version.observationIds.every(id => r.observations.some(o => o.id === id && o.field === 'cacheVersion' && o.origin === 'user_provided' && o.verification === 'user_declared')));
        assert.equal(api.exitCode(r), 2);
    }
});
test('I01 version conflict, masking and partial evidence stay pending independently of paths', async () => {
    for (const state of ['conflict', 'masked', 'partial']) {
        const r = await changed('path-change', c => {
            for (const run of ['a', 'b'])
                c.runs[run].steps[0].evidence.find((e: any) => e.field === 'resolvedPaths').value = ['.cache/shared'];
            const evidence = c.runs.a.steps[0].evidence;
            if (state === 'conflict')
                evidence.push({ field: 'cacheVersion', state: 'value', value: 'other-version' });
            else if (state === 'masked')
                evidence.find((e: any) => e.field === 'cacheVersion').value = '***';
            else
                c.runs.a.steps[0].evidence = evidence.filter((e: any) => e.field !== 'cacheVersion');
            return { c };
        });
        assert.ok(!r.findings.some(f => f.code === 'CACHE_VERSION_DIFFERENT'));
        const pending = r.findings.find(f => f.code === 'CACHE_VERSION_PENDING')!;
        assert.ok(pending);
        assert.equal(pending.certainty, state === 'conflict' ? 'conflict' : 'unknown');
        assert.ok(pending.missingEvidence.some(m => m.code === 'CACHE_VERSION'));
    }
});
test('I01 paths can differ without a version difference and absent optional versions do not force pending', async () => {
    const equalVersions = await changed('path-change', c => {
        c.runs.b.steps[0].evidence.find((e: any) => e.field === 'cacheVersion').value = 'ver-a';
        return { c };
    });
    assert.ok(equalVersions.findings.some(f => f.code === 'RESOLVED_PATH_CHANGED'));
    assert.ok(!equalVersions.findings.some(f => f.code === 'CACHE_VERSION_DIFFERENT' || f.code === 'CACHE_VERSION_PENDING'));
    const absentVersions = await changed('path-change', c => {
        for (const run of ['a', 'b']) {
            c.runs[run].steps[0].evidence = c.runs[run].steps[0].evidence.filter((e: any) => e.field !== 'cacheVersion');
            c.runs[run].steps[0].evidence.find((e: any) => e.field === 'resolvedPaths').value = ['.cache/shared'];
        }
        return { c };
    });
    assert.ok(!absentVersions.findings.some(f => f.code === 'CACHE_VERSION_PENDING'));
});
test('I01 version facts still require a unique main association', async () => {
    const r = await changed('path-change', c => {
        c.runs.a.steps[0].regions.push({ id: 'another-main', phase: 'main', startLine: 2, endLine: 6 });
        return { c };
    });
    assert.ok(!r.findings.some(f => f.code === 'CACHE_VERSION_DIFFERENT'));
    const pending = r.findings.find(f => f.code === 'CACHE_VERSION_PENDING')!;
    assert.ok(pending.missingEvidence.some(m => m.code === 'RUN_ASSOCIATION'));
    assert.equal(api.exitCode(r), 2);
});
for (const [lineEnding, newline] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']] as const) {
test(`I02 declared cache enablement and manager do not confirm the package cache object (${lineEnding})`, async () => {
    const r = await changed('package-cache', (c, w) => {
        for (const run of ['a', 'b'])
            c.runs[run].steps[0].evidence.push({ field: 'cacheEnabled', state: 'value', value: true }, { field: 'packageManager', state: 'value', value: 'npm' });
        const workflow = w.replace(/\r\n|\r|\n/g, newline);
        const withoutCache = workflow.replace(/        with:(?:\r\n|\r|\n)          cache: npm(?:\r\n|\r|\n)/, '');
        assert.notEqual(withoutCache, workflow, 'fixture must remove the workflow cache declaration');
        assert.ok(!withoutCache.includes('cache: npm'));
        return { c, w: withoutCache };
    });
    const declared = r.observations.filter(o => o.field === 'cacheEnabled' || o.field === 'packageManager');
    assert.equal(declared.length, 4);
    assert.ok(declared.every(o => o.origin === 'user_provided' && o.verification === 'user_declared' && o.status === 'candidate'));
    assert.ok(r.observations.some(o => o.field === 'restoredKey' && o.origin === 'log' && o.verification === 'verified'));
    assert.ok(!r.findings.some(f => f.code === 'PACKAGE_CACHE_OBJECT'));
    const pending = r.findings.find(f => f.code === 'PACKAGE_CACHE_PENDING')!;
    assert.equal(pending.kind, 'pending');
    assert.equal(pending.certainty, 'unknown');
    assert.ok(pending.missingEvidence.some(m => m.code === 'CACHE_ENABLEMENT'));
    assert.ok(declared.every(o => pending.observationIds.includes(o.id)));
    assert.equal(api.exitCode(r), 2);
});
test(`I02 conflicting enablement declarations retain conflict rather than confirmed object evidence (${lineEnding})`, async () => {
    const r = await changed('package-cache', (c, w) => {
        for (const run of ['a', 'b'])
            c.runs[run].steps[0].evidence.push({ field: 'cacheEnabled', state: 'value', value: true }, { field: 'cacheEnabled', state: 'value', value: false }, { field: 'packageManager', state: 'value', value: 'npm' });
        const workflow = w.replace(/\r\n|\r|\n/g, newline);
        const withoutCache = workflow.replace(/        with:(?:\r\n|\r|\n)          cache: npm(?:\r\n|\r|\n)/, '');
        assert.notEqual(withoutCache, workflow, 'fixture must remove the workflow cache declaration');
        assert.ok(!withoutCache.includes('cache: npm'));
        return { c, w: withoutCache };
    });
    assert.ok(!r.findings.some(f => f.code === 'PACKAGE_CACHE_OBJECT'));
    const pending = r.findings.find(f => f.code === 'PACKAGE_CACHE_PENDING')!;
    assert.equal(pending.certainty, 'conflict');
    assert.ok(pending.missingEvidence.some(m => m.code === 'CACHE_ENABLEMENT'));
});
}
test('I03 conflicting or masked post outcomes and reasons cannot confirm a normal-policy skip', async () => {
    for (const kind of ['log-outcomes', 'declared-outcome', 'declared-reason', 'masked-outcome', 'masked-reason']) {
        const r = await changed('path-change', (c, w, l) => {
            for (const run of ['a', 'b']) {
                const step = c.runs[run].steps[0];
                step.regions.push({ id: 'post', phase: 'post', startLine: 7, endLine: kind === 'log-outcomes' ? 8 : 7, parentRegionId: 'main', complete: true });
                if (kind === 'declared-outcome')
                    step.evidence.push({ field: 'saveOutcome', state: 'value', value: 'saved' });
                if (kind === 'declared-reason')
                    step.evidence.push({ field: 'saveReason', state: 'value', value: { class: 'failure', code: 'DECLARED_FAILURE' } });
                if (kind === 'masked-outcome')
                    step.evidence.push({ field: 'saveOutcome', state: 'masked' });
                if (kind === 'masked-reason')
                    step.evidence.push({ field: 'saveReason', state: 'value', value: { class: 'normal-policy', code: '***' } });
            }
            return { c, l: l + 'Cache hit occurred on the primary key public, not saving cache.\n' + (kind === 'log-outcomes' ? 'Cache saved with key: public\n' : '') };
        });
        assert.ok(!r.findings.some(f => f.code === 'SAVE_SKIPPED_NORMAL_POLICY'), kind);
        const pending = r.findings.find(f => f.code === 'SAVE_OUTCOME_PENDING')!;
        assert.equal(pending.certainty, kind.startsWith('masked') ? 'unknown' : 'conflict');
        const saveEvidence = r.observations.filter(o => o.field === 'saveOutcome' || o.field === 'saveReason');
        assert.ok(saveEvidence.length >= 6);
        assert.ok(saveEvidence.every(o => pending.observationIds.includes(o.id)));
        assert.ok(saveEvidence.every(o => o.refs.every(ref => pending.evidenceRefs.some(q => JSON.stringify(q) === JSON.stringify(ref)))));
        for (const ref of pending.evidenceRefs)
            for (const line of new Set([ref.startLine, ref.endLine]))
                assert.ok(r.excerpts.some(e => e.ref.sourceId === ref.sourceId && e.lines.some(l => l.line === line && l.parts.length)));
        if (kind === 'log-outcomes')
            for (const runId of ['a', 'b']) {
                const outcomes = saveEvidence.filter(o => o.runId === runId && o.field === 'saveOutcome');
                assert.deepEqual(outcomes.map(o => o.value.state === 'value' ? o.value.value : null), ['skipped', 'saved']);
                assert.ok(outcomes.every(o => o.status === 'conflict' && o.origin === 'log' && o.verification === 'verified'));
            }
        assert.equal(api.exitCode(r), 2);
    }
});
test('I03 a conflict in run a does not contaminate the consistent skip evidence from run b', async () => {
    const d = join(process.cwd(), 'fixtures/path-change');
    const c = JSON.parse(await readFile(join(d, 'context.json'), 'utf8'));
    const w = await readFile(join(d, 'workflow.yml'), 'utf8'), l = await readFile(join(d, 'run-a.txt'), 'utf8');
    const skip = 'Cache hit occurred on the primary key public, not saving cache.\n';
    for (const run of ['a', 'b'])
        c.runs[run].steps[0].regions.push({ id: 'post', phase: 'post', startLine: 7, endLine: run === 'a' ? 8 : 7, parentRegionId: 'main', complete: true });
    const f = await fixture(w, l + skip + 'Cache saved with key: public\n', l + skip, c);
    try {
        const x = await api.loadAnalysisInputs(f.paths);
        assert.ok(x.ok);
        const r = analyze(x.value.inputs);
        assert.equal(r.findings.find(f => f.code === 'SAVE_OUTCOME_PENDING')!.certainty, 'conflict');
        const facts = r.findings.filter(f => f.code === 'SAVE_SKIPPED_NORMAL_POLICY');
        assert.equal(facts.length, 1);
        assert.ok(facts[0]!.observationIds.every(id => r.observations.some(o => o.id === id && o.runId === 'b')));
        assert.equal(api.exitCode(r), 2);
    }
    finally {
        await f.cleanup();
    }
});
test('selected scope excludes unrelated user text and never fixes missing association', async () => {
    const d = join(process.cwd(), 'fixtures/path-change'), w = await readFile(join(d, 'workflow.yml'), 'utf8'), l = await readFile(join(d, 'run-a.txt'), 'utf8'), c = JSON.parse(await readFile(join(d, 'context.json'), 'utf8'));
    for (const run of ['a', 'b'])
        c.runs[run].steps.push({ target: { jobId: 'build', stepIndex: 1 }, regions: [{ id: 'other', phase: 'main', startLine: 7, endLine: 7 }], evidence: [{ field: 'primaryKey', state: 'value', value: 'UNRELATED_PUBLIC_FRAGMENT' }] });
    const f = await fixture(w + '      - id: other\n        uses: actions/cache@v4.0.2\n        with:\n          key: unrelated\n          path: .other\n', l + 'ordinary\n', l + 'ordinary\n', c);
    try {
        const x = await api.loadAnalysisInputs(f.paths);
        assert.ok(x.ok);
        const all = api.analyzeInputs(x.value.inputs);
        assert.ok(all.ok);
        assert.equal(all.value.stepViews.length, 2);
        const r = api.analyzeInputs(x.value.inputs, { step: { kind: 'stepId', value: 'cache' as any } });
        assert.ok(r.ok);
        assert.equal(r.value.stepViews.length, 1);
        assert.equal(r.value.comparisons.length, 5);
        assert.ok(!JSON.stringify(r.value).includes('UNRELATED_PUBLIC_FRAGMENT'));
        assert.ok(r.value.observations.every(o => o.stepRef === r.value.steps[0]!.stepRef));
        assert.ok(Object.isFrozen(x.value.inputs));
    }
    finally {
        await f.cleanup();
    }
});
test('selected restore retains referenced save support DTO without computing another step view', async () => {
    const d = join(process.cwd(), 'fixtures/restore-only'), w = await readFile(join(d, 'workflow.yml'), 'utf8'), l = await readFile(join(d, 'run-a.txt'), 'utf8'), c = JSON.parse(await readFile(join(d, 'context.json'), 'utf8'));
    const sha = '0c45773b623bea8c8e75f6c82b208c3cf94ea4f9';
    for (const run of ['a', 'b']) {
        c.runs[run].steps[0].saveTargets = [{ jobId: 'build', stepIndex: 1 }];
        c.runs[run].steps.push({ target: { jobId: 'build', stepIndex: 1 }, regions: [{ id: 'save', phase: 'save', startLine: 8, endLine: 12 }], evidence: [{ field: 'executedCommit', state: 'value', value: sha, logRanges: [{ startLine: 7, endLine: 7 }] }] });
    }
    const log = l + `Download action repository 'actions/cache@v4.0.2' (SHA:${sha})\n##[group]Run actions/cache/save@v4.0.2\nwith:\n  key: public\n##[endgroup]\nCache saved with key: public\n`;
    const f = await fixture(w + '      - id: saver\n        uses: actions/cache/save@v4.0.2\n        with:\n          key: public\n          path: .cache\n', log, log, c);
    try {
        const x = await api.loadAnalysisInputs(f.paths);
        assert.ok(x.ok);
        const r = api.analyzeInputs(x.value.inputs, { step: { kind: 'stepId', value: 'cache' as any } });
        assert.ok(r.ok);
        assert.equal(r.value.steps.length, 2);
        assert.equal(r.value.stepViews.length, 1);
        assert.equal(r.value.comparisons.length, 5);
        assert.equal(r.value.selectedSteps.length, 1);
        const ids = new Set(r.value.steps.map(s => s.stepRef));
        assert.ok(r.value.associations.steps.flatMap(s => [...s.runA, ...s.runB]).every(c => c.saveStepRefs.every(s => ids.has(s))));
        assert.ok(r.value.observations.every(o => !o.stepRef || ids.has(o.stepRef)));
        assert.ok(!r.value.findings.some(f => f.code === 'RESTORE_ONLY_CONFIG'));
    }
    finally {
        await f.cleanup();
    }
});

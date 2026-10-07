import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadAnalysisInputs } from '../src/input.ts';
import { associateSteps } from '../src/associate.ts';
for (const folder of ['import-official-cache', 'import-official-node'])
    test(`handwritten fixed official source fixture ${folder}`, async () => {
        const base = join(process.cwd(), 'fixtures', folder);
        const expected = JSON.parse(await readFile(join(base, 'expected.json'), 'utf8'));
        const paths = { workflow: join(base, 'workflow.yml'), runA: join(base, 'run-a.txt'), runB: join(base, 'run-b.txt'), context: join(base, 'context.json') };
        const r = await loadAnalysisInputs(paths);
        assert.ok(r.ok);
        const x = r.value.inputs;
        const wf = x.workflow.steps[0];
        assert.equal(wf.actionKind, expected.actionKind);
        assert.deepEqual(wf.actionRef, { state: 'value', value: expected.actionRef });
        assert.equal(wf.stepRef, x.sources[0].id + '/j0/s0');
        assert.equal(wf.range.startLine, expected.step.startLine);
        assert.equal(wf.range.endLine, expected.step.endLine);
        for (let i = 0; i < 2; i++) {
            const wanted = expected.runs[i], run = x.runs[i];
            const o = run.observations.find(o => o.field === wanted.field)!;
            assert.deepEqual(o.value, { state: 'value', value: wanted.value });
            assert.equal(o.origin, wanted.origin);
            assert.equal(o.verification, wanted.verification);
            assert.equal(o.refs[0].startLine, wanted.logLine);
            const p = x.profile.patterns.find(p => p.id === o.patternId)!;
            assert.ok(p.fixtureIds.includes(expected.fixtureId));
            const s = x.profile.codeSources.find(s => s.id === p.sourceId)!;
            for (const k of Object.keys(expected.source))
                assert.equal(s[k as keyof typeof s], expected.source[k]);
            const excerpt = x.excerpts.find(e => e.ref.sourceId === run.sourceId && e.lines.some(l => l.parts.some(p => p.text === wanted.capture)))!;
            assert.equal(excerpt.lines[0].parts[0].startColumn, wanted.startColumn);
            assert.equal(excerpt.lines[0].parts[0].endColumn, wanted.endColumn);
            const region = x.context!.steps[i].regions[0];
            assert.equal(region.declarationRef.jsonPointer, wanted.contextPointer);
            assert.equal(region.declarationRef.startLine, wanted.contextLine);
            assert.equal(run.sourceId, 'src:log-' + wanted.runId + ':' + createHash('sha256').update(await readFile(i === 0 ? paths.runA : paths.runB)).digest('hex'));
        }
        const a = associateSteps(x);
        assert.ok(a.ok);
        const step = a.value.steps[0];
        assert.equal(step.status, expected.association.status);
        assert.ok(step.selected);
        assert.equal(step.runA[0].mainStatus, expected.association.mainStatus);
        assert.equal(step.runA[0].saveStatus, expected.association.saveStatus);
        assert.equal(step.runA[0].basis, expected.association.basis);
    });

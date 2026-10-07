import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, simple } from './helpers.ts';
import { loadAnalysisInputs } from '../src/input.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
test('workflow shell marker is inert and every explicitly imported byte hash stays unchanged', async () => {
    const f = await fixture();
    try {
        const marker = join(f.dir, 'execution-marker.txt');
        await writeFile(f.paths.workflow, simple + '      - run: echo executed > "' + marker + '"\n');
        const paths = Object.values(f.paths);
        const before = await Promise.all(paths.map(p => readFile(p)));
        const r = await loadAnalysisInputs(f.paths);
        assert.ok(r.ok);
        await assert.rejects(readFile(marker), (e: any) => e.code === 'ENOENT');
        const after = await Promise.all(paths.map(p => readFile(p)));
        assert.ok(before.every((b, i) => b.equals(after[i])));
        for (let i = 0; i < paths.length; i++)
            assert.equal(r.value.inputs.sources[i].sha256, createHash('sha256').update(before[i]).digest('hex'));
        assert.ok(!JSON.stringify(r.value.inputs).includes(f.dir));
    }
    finally {
        await f.cleanup();
    }
});

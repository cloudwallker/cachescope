import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.ts';
const cli = (...args: string[]) => spawnSync(process.execPath, ['src/cli.ts', ...args], { encoding: 'utf8' });
for (const name of ['dynamic-key', 'lockfile-path', 'path-change', 'restore-only', 'package-cache']) {
    test(`CLI computes ${name} from packaged input with honest pending exit`, async () => {
        const r = cli('demo', name, '--json');
        assert.equal(r.status, 2, r.stderr);
        const report = JSON.parse(r.stdout);
        const expected = JSON.parse(await readFile(`fixtures/${name}/expected.json`, 'utf8'));
        assert.equal(report.schemaVersion, 1);
        for (const f of expected.findings)
            assert.ok(report.findings.some((x: any) => x.code === f.code && x.kind === f.kind && x.certainty === f.certainty));
        assert.ok(report.sources.length >= 3);
        assert.equal(r.stderr, '');
    });
}
test('CLI invalid flags produce one safe JSON envelope and exit 3', () => {
    for (const args of [['--wat', 'password=do-not-disclose'], ['--locale', 'zz'], ['--json', '--json'], ['demo', 'missing'], ['demo', '--overwrite']]) {
        const r = cli(...args, ...(args.includes('--json') ? [] : ['--json']));
        assert.equal(r.status, 3);
        assert.equal(JSON.parse(r.stdout).schemaVersion, 1);
        assert.ok(JSON.parse(r.stdout).error.diagnostics.length);
        assert.doesNotMatch(r.stdout + r.stderr, /do-not-disclose|Error:|node:|\.ts:\d/);
    }
});
test('CLI selection accepts the stable ref of a no-id step', async () => {
    const f = await fixture();
    try {
        const base = ['--workflow', f.paths.workflow, '--run-a', f.paths.runA, '--run-b', f.paths.runB, '--json'];
        const all = JSON.parse(cli(...base).stdout);
        const r = cli(...base, '--step', all.steps[0].stepRef);
        assert.equal(r.status, 2);
        assert.deepEqual(JSON.parse(r.stdout).selectedSteps, [all.steps[0].stepRef]);
        assert.equal(cli(...base, '--step', 'absent').status, 3);
    }
    finally {
        await f.cleanup();
    }
});
test('CLI writes both reports, refuses existing output, and preserves input aliases', async () => {
    const f = await fixture();
    try {
        const base = ['--workflow', f.paths.workflow, '--run-a', f.paths.runA, '--run-b', f.paths.runB, '--json'];
        const html = join(f.dir, 'report.html'), json = join(f.dir, 'report.json');
        const r = cli(...base, '--html', html, '--output-json', json);
        assert.equal(r.status, 2, r.stdout);
        assert.deepEqual(JSON.parse(await readFile(json, 'utf8')), JSON.parse(r.stdout));
        assert.match(await readFile(html, 'utf8'), /CacheScope/);
        assert.equal(cli(...base, '--html', html).status, 3);
        assert.equal(cli(...base, '--html', html, '--overwrite').status, 2);
        const before = await readFile(f.paths.workflow);
        assert.equal(cli(...base, '--html', f.paths.workflow, '--overwrite').status, 3);
        assert.deepEqual(await readFile(f.paths.workflow), before);
        assert.equal(cli(...base, '--html', html, '--output-json', html, '--overwrite').status, 3);
    }
    finally {
        await f.cleanup();
    }
});
test('CLI version and locale retain report facts', () => {
    assert.match(cli('--version').stdout, /^0\.1\.0\s*$/);
    const a = cli('demo', '--json', '--locale', 'en');
    const b = cli('demo', '--json', '--locale', 'zh-CN');
    assert.deepEqual(JSON.parse(a.stdout), JSON.parse(b.stdout));
});

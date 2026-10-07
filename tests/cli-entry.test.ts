import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { symlink, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture } from './helpers.ts';

const entry = process.env.CACHESCOPE_TEST_CLI ?? resolve('dist/cli.js');
function invoke(args: string[]) {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.error, undefined, 'CHILD_START_FAILED');
    return result;
}
for (const kind of ['target', 'symlink'] as const) {
    for (const command of ['version', 'demo'] as const) {
        test(`real ${kind} CLI entry executes ${command}`, async () => {
            const f = await fixture();
            try {
                const link = join(f.dir, 'cachescope.js');
                await symlink(entry, link, 'file');
                assert.equal((await lstat(link)).isSymbolicLink(), true);
                const result = invoke([kind === 'target' ? entry : link, ...(command === 'version' ? ['--version'] : ['demo', '--json'])]);
                assert.equal(result.status, command === 'version' ? 0 : 2);
                assert.equal(result.stderr, '');
                if (command === 'version') assert.equal(result.stdout, '0.1.0\n');
                else {
                    const report = JSON.parse(result.stdout);
                    assert.equal(report.schemaVersion, 1);
                    assert.ok(report.findings.some((finding: { kind: string }) => finding.kind === 'pending'));
                }
            } finally { await f.cleanup(); }
        });
    }
}
test('importing CLI from another existing entry does not run a command', () => {
    const result = invoke(['--input-type=module', '-e', `process.argv[1]=${JSON.stringify(resolve('tests/cli-entry.test.ts'))};process.argv[2]='--version';await import(${JSON.stringify(pathToFileURL(entry).href)});`]);
    assert.equal(result.status, 0);assert.equal(result.stdout, '');assert.equal(result.stderr, '');
});
test('entry realpath failure emits only a fixed safe diagnostic and exits 3', async () => {
    const f = await fixture();
    try {
        const result = invoke(['--input-type=module', '-e', `process.argv[1]=${JSON.stringify(join(f.dir, 'missing-entry.js'))};await import(${JSON.stringify(pathToFileURL(entry).href)});`]);
        assert.equal(result.status, 3);assert.equal(result.stdout, '');
        assert.equal(result.stderr === 'output: CLI_ENTRY_FAILURE\n', true, 'ENTRY_FAILURE_MUST_BE_SAFE');
    } finally { await f.cleanup(); }
});

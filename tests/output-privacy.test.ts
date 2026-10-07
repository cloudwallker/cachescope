import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, simple, contextFor } from './helpers.ts';
const cli = (...args: string[]) => spawnSync(process.execPath, ['src/cli.ts', ...args], { encoding: 'utf8' });
test('stdout, stderr, file JSON, HTML and suggestion templates exclude every synthetic secret', async () => {
    const secrets = ['password: short-private', 'Bearer private-bearer', 'https://person:private-url@sample.invalid/cache', 'https://sample.invalid/?token=private-query', '${{ secrets.PRIVATE_VALUE }}', '-----BEGIN PRIVATE KEY-----\nprivate-pem-material\n-----END PRIVATE KEY-----', ['aB9dE3fG', '7hJ1kL5m', 'N8pQ2rS6', 'tU4vW0xYz'].join('')];
    for (const secret of secrets) {
        const c = contextFor(undefined, [{ field: 'primaryKey', state: 'value', value: secret }, { field: 'resolvedPaths', state: 'value', value: [secret] }]);
        const f = await fixture(simple.replace('public-key', JSON.stringify(secret)).replace('.cache', JSON.stringify(secret)), 'x', 'x', c, [{ id: 1, key: secret, version: 'one', ref: 'refs/heads/main' }]);
        try {
            const html = join(f.dir, 'report.html'), json = join(f.dir, 'report.json');
            const args = ['--workflow', f.paths.workflow, '--run-a', f.paths.runA, '--run-b', f.paths.runB, '--context', f.paths.context!, '--cache-list', f.paths.cacheList!];
            const r = cli(...args, '--json', '--html', html, '--output-json', json);
            assert.equal(r.status, 2, r.stdout);
            const channels = [r.stdout, r.stderr, await readFile(html, 'utf8'), await readFile(json, 'utf8')];
            const report = JSON.parse(r.stdout);
            channels.push(...report.suggestions.map((s: any) => s.yaml));
            const human = cli(...args);
            channels.push(human.stdout, human.stderr);
            for (const channel of channels) {
                assert.ok(!channel.includes(secret));
                assert.ok(!channel.includes(f.dir));
                assert.ok(!channel.includes('private-pem-material'));
            }
            assert.deepEqual(JSON.parse(await readFile(json, 'utf8')), report);
        }
        finally {
            await f.cleanup();
        }
    }
});

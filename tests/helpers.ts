import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
export const simple = 'jobs:\n  build:\n    steps:\n      - uses: actions/cache@v4.0.2\n        with:\n          key: public-key\n          path: .cache\n';
export async function fixture(workflow: string | Uint8Array = simple, a: string | Uint8Array = '', b: string | Uint8Array = '', context?: unknown, cacheList?: unknown) {
    const root = join(process.cwd(), '.test-tmp');
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, 'case-'));
    const paths = { workflow: join(dir, 'workflow.yml'), runA: join(dir, 'a.log'), runB: join(dir, 'b.log'), ...(context === undefined ? {} : { context: join(dir, 'context.json') }), ...(cacheList === undefined ? {} : { cacheList: join(dir, 'cache-list.json') }) };
    await writeFile(paths.workflow, workflow);
    await writeFile(paths.runA, a);
    await writeFile(paths.runB, b);
    if (paths.context)
        await writeFile(paths.context, typeof context === 'string' ? context : JSON.stringify(context, null, 2));
    if (paths.cacheList)
        await writeFile(paths.cacheList, typeof cacheList === 'string' ? cacheList : JSON.stringify(cacheList, null, 2));
    return { dir, paths, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
export function contextFor(regions: unknown[] = [{ id: 'main', phase: 'main', startLine: 1, endLine: 1 }], evidence: unknown[] = []) {
    return { schemaVersion: 1, runs: { a: { steps: [{ target: { jobId: 'build', stepIndex: 0 }, regions, evidence }] }, b: { steps: [{ target: { jobId: 'build', stepIndex: 0 }, regions, evidence }] } } };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, link, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, simple, contextFor } from './helpers.ts';
// Dynamic import intentionally lets missing production API fail an assertion, not test discovery.
async function api() { const m = await import('../src/input.ts').catch(() => ({})); assert.equal(typeof m.loadAnalysisInputs, 'function', 'real loader is required'); return m; }
async function load(...args: Parameters<typeof fixture>) {
    const f = await fixture(...args);
    try {
        return await (await api()).loadAnalysisInputs(f.paths);
    }
    finally {
        await f.cleanup();
    }
}
function value(r: any) { assert.equal(r.ok, true); return r.value.inputs; }
function code(r: any, c: string) { assert.equal(r.ok, false); assert.ok(r.diagnostics.some((d: any) => d.code === c)); assert.ok(r.diagnostics.every((d: any) => !('cause' in d) && !('stack' in d))); }
test('loader owns immutable registered sources with original byte hash and physical CR lines', async () => {
    const w = simple.replaceAll('\n', '\r\n');
    const x = value(await load(w, '\x1b[31mCache restored from key: public-key\x1b[0m\rnext\r', ''));
    assert.equal(x.sources[0].lineCount, 7);
    assert.equal(x.sources[1].lineCount, 2);
    assert.equal(x.sources[0].id, 'src:workflow:' + createHash('sha256').update(w).digest('hex'));
    assert.equal(x.workflow.steps[0].range.startLine, 4);
    assert.equal(x.workflow.steps[0].inputs[0].refs[0].startLine, 6);
    assert.ok(Object.isFrozen(x) && Object.isFrozen(x.workflow.steps[0].inputs));
    assert.equal(x.runs[0].observations.length, 0, 'unmapped log cannot be action fact');
});
test('duplicate YAML keys, cycles, malformed UTF8 and NUL are safe failures', async () => {
    code(await load('jobs: {}\njobs: {}'), 'YAML_INVALID');
    code(await load('jobs: &a {x: *a}'), 'ALIAS_CYCLE');
    code(await load(new Uint8Array([255])), 'UTF8_INVALID');
    code(await load(simple + '\0'), 'NUL_INVALID');
});
test('fixed official restore pattern captures line 1 via context and mutable tag remains unverified', async () => {
    const x = value(await load(simple, '\x1b[32mCache restored from key: public-key\x1b[0m', 'Cache restored from key: next-key', contextFor()));
    const o = x.runs[0].observations.find((o: any) => o.field === 'restoredKey');
    assert.deepEqual(o.value, { state: 'value', value: 'public-key' });
    assert.equal(o.refs[0].startLine, 1);
    assert.equal(o.patternId, 'pattern:0adf8aca95e4b2ab5bd7d035b5ea432821dc85ec4145cdca94bd31b741cf2a4e');
    assert.equal(o.verification, 'unverified');
    const p = x.profile.patterns.find((p: any) => p.id === o.patternId), s = x.profile.codeSources.find((s: any) => s.id === p.sourceId);
    assert.equal(s.commit, '0c45773b623bea8c8e75f6c82b208c3cf94ea4f9');
    assert.equal(s.contentSha256, 'd816b5f35d5b7821298581d941443f20646867d63c783519ee7982b7150a401c');
    assert.equal(s.startLine, 81);
    assert.ok(x.excerpts.every((e: any) => e.lines.every((l: any) => l.parts.every((p: any) => p.text !== 'Cache restored from key: public-key'))));
});
test('setup-node fixed restore pattern is covered independently', async () => {
    const w = simple.replace('actions/cache@v4.0.2', 'actions/setup-node@v4.0.4');
    const x = value(await load(w, 'Cache restored from key: node-public', 'Cache restored from key: node-other', contextFor()));
    const o = x.runs[0].observations.find((o: any) => o.field === 'restoredKey');
    assert.equal(o.patternId, 'pattern:6b9a6b5c5b1f1b1c0f81077a29e43818875139611b74464e05705d7e99addcda');
    assert.deepEqual(o.value, { state: 'value', value: 'node-public' });
    const p = x.profile.patterns.find((p: any) => p.id === o.patternId);
    assert.equal(x.profile.codeSources.find((s: any) => s.id === p.sourceId).contentSha256, 'fca317ce72b603adc608fa2bf4a93d82a28dc77698999a68d4e0301c4e995f19');
});
test('context preserves cacheHit four states and conflict evidence without promoting origin', async () => {
    const c = contextFor(undefined, [{ field: 'cacheHit', state: 'value', value: 'true' }, { field: 'cacheHit', state: 'value', value: 'false' }, { field: 'cacheHit', state: 'value', value: 'empty' }, { field: 'cacheHit', state: 'value', value: 'unrecorded' }, { field: 'primaryKey', state: 'missing' }, { field: 'primaryKey', state: 'empty' }]);
    const x = value(await load(simple, 'ordinary', 'ordinary', c));
    const os = x.runs[0].observations.filter((o: any) => o.field === 'cacheHit');
    assert.deepEqual(os.map((o: any) => o.value.value), ['true', 'false', 'empty', 'unrecorded']);
    assert.ok(os.every((o: any) => o.origin === 'user_provided' && o.verification === 'user_declared'));
    assert.ok(os.slice(0, 3).every((o: any) => o.status === 'conflict'));
});
test('context rejects resolvedKey alias and invalid regions while dropping unrelated unknown text', async () => {
    code(await load(simple, 'x', 'x', contextFor(undefined, [{ field: 'resolvedKey', state: 'value', value: 'x' }])), 'UNKNOWN_FIELD_ALIAS');
    code(await load(simple, 'x', 'x', contextFor([{ id: 'x', phase: 'main', startLine: 0, endLine: 1 }])), 'SOURCE_REF_INVALID');
    const c = { ...contextFor(), unknown: 'unrelated-free-text' };
    assert.ok(!JSON.stringify(value(await load(simple, 'x', 'x', c))).includes('unrelated-free-text'));
});
test('cache-list preserves same key versions and refuses count conflicts', async () => {
    const x = value(await load(simple, '', '', undefined, { actions_caches: [{ id: 1, key: 'same', version: 'v1', ref: 'refs/heads/main' }, { id: 2, key: 'same', version: 'v2', ref: 'refs/heads/topic' }], total_count: 4 }));
    assert.equal(x.cacheList.pagination.state, 'incomplete');
    assert.equal(x.cacheList.entries.length, 2);
    assert.deepEqual(x.cacheList.entries.map((e: any) => e.version.value), ['v1', 'v2']);
    const y = value(await load(simple, '', '', undefined, { actions_caches: [{ id: 1, key: 'a' }, { id: 1, key: 'b' }], total_count: 1 }));
    assert.equal(y.cacheList.pagination.state, 'conflict');
    assert.ok(y.cacheList.diagnostics.some((d: any) => d.code === 'CACHE_PROVIDER_CONFLICT'));
});
test('secrets are masked before observations/excerpts, script is never run and bytes remain unchanged', async () => {
    const marker = 'ghp_' + 'Xy9J'.repeat(10);
    const w = simple.replace('public-key', marker) + '      - run: echo execution-marker\n';
    const f = await fixture(w, 'Cache restored from key: ' + marker, 'Cache restored from key: ' + marker, contextFor(undefined, [{ field: 'primaryKey', state: 'value', value: marker }]));
    try {
        const before = await readFile(f.paths.workflow);
        const r = await (await api()).loadAnalysisInputs(f.paths);
        const x = value(r);
        assert.ok(!JSON.stringify(x).includes(marker));
        assert.equal(x.workflow.steps[0].inputs[0].value.state, 'masked');
        assert.deepEqual(await readFile(f.paths.workflow), before);
        assert.throws(() => JSON.stringify(r.value.guard), /PRIVATE_CAPABILITY/);
        assert.throws(() => JSON.stringify(r.value), /PRIVATE_CAPABILITY/);
    }
    finally {
        await f.cleanup();
    }
});
test('association refuses forged/cloned inputs and does not choose first of anonymous blocks', async () => {
    const x = value(await load(simple, 'Cache restored from key: a\nCache restored from key: b', 'Cache restored from key: c'));
    const m = await import('../src/associate.ts').catch(() => ({}));
    assert.equal(typeof m.associateSteps, 'function');
    code(m.associateSteps(JSON.parse(JSON.stringify(x))), 'UNTRUSTED_INPUTS');
    const r = m.associateSteps(x);
    assert.equal(r.ok, true);
    assert.equal(r.value.steps[0].status, 'missing');
    assert.equal(r.value.steps[0].selected, undefined);
});
test('output permits accept explicit outside paths but reject input aliases and collisions', async () => {
    const f = await fixture();
    try {
        const m = await api();
        const r = await m.loadAnalysisInputs(f.paths);
        assert.equal(r.ok, true);
        const p = await m.prepareOutputs(r.value, [{ kind: 'json', path: join(f.dir, 'out.json') }], { overwrite: false });
        assert.equal(p.ok, true);
        assert.throws(() => JSON.stringify(p.value), /PRIVATE_CAPABILITY/);
        assert.equal((await m.revalidateOutputPermit(p.value)).ok, true);
        code(await m.prepareOutputs(r.value, [{ kind: 'json', path: f.paths.workflow }], { overwrite: true }), 'OUTPUT_INPUT_ALIAS');
        const alias = join(f.dir, 'alias');
        await link(f.paths.runA, alias);
        code(await m.prepareOutputs(r.value, [{ kind: 'json', path: alias }], { overwrite: true }), 'OUTPUT_INPUT_ALIAS');
        code(await m.prepareOutputs(r.value, [{ kind: 'json', path: join(f.dir, 'out') }, { kind: 'html', path: join(f.dir, 'out') }], { overwrite: false }), 'OUTPUT_COLLISION');
        await writeFile(f.paths.runA, 'changed');
        code(await m.revalidateOutputPermit(p.value), 'INPUT_CHANGED');
    }
    finally {
        await f.cleanup();
    }
});

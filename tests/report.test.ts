import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAnalysisInputs } from '../src/input.ts';
import { analyzeInputs } from '../src/analyze.ts';
import { fixture } from './helpers.ts';
test('renderer embeds the identical computed report and safely encodes closing scripts', async () => {
    const f = await fixture('jobs:\n  build:\n    steps:\n      - uses: actions/cache@v4.0.2\n        with:\n          key: "</script><script>globalThis.injected=1</script>\\u2028\\u2029"\n          path: .cache\n');
    try {
        const loaded = await loadAnalysisInputs(f.paths);
        assert.ok(loaded.ok);
        const r = analyzeInputs(loaded.value.inputs);
        assert.ok(r.ok);
        const m = await import('../src/report.ts').catch(() => null);
        assert.ok(m, 'offline renderer must exist');
        const html = m.renderHtml(r.value);
        assert.ok(html.ok);
        const match = html.value.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/);
        assert.ok(match);
        assert.deepEqual(JSON.parse(match[1]!), r.value);
        assert.doesNotMatch(match[1]!, /<|\u2028|\u2029/);
        assert.doesNotMatch(html.value, /<script src=|<link[^>]+href=|@import|fetch\(/);
        assert.equal(m.renderHtml(JSON.parse(JSON.stringify(r.value))).ok, false, 'forged reports must not render');
    }
    finally {
        await f.cleanup();
    }
});

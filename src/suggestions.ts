import type { BaseReport, Result, Suggestion } from './model.ts';
import { ok, id, staticText } from './safety.ts';
const templates = {
    key: { yaml: '- uses: actions/cache@v4.0.2\n  with:\n    key: ${{ runner.os }}-${{ hashFiles(\'REPLACE_WITH_LOCKFILE_PATH\') }}\n    path: REPLACE_WITH_CACHE_PATH\n', names: ['REPLACE_WITH_LOCKFILE_PATH', 'REPLACE_WITH_CACHE_PATH'] },
    lockfile: { yaml: '- uses: actions/setup-node@v4.0.4\n  with:\n    cache: npm\n    cache-dependency-path: REPLACE_WITH_LOCKFILE_PATH\n', names: ['REPLACE_WITH_LOCKFILE_PATH'] },
    path: { yaml: '- uses: actions/cache@v4.0.2\n  with:\n    key: REPLACE_WITH_CACHE_KEY\n    path: REPLACE_WITH_CACHE_PATH\n', names: ['REPLACE_WITH_CACHE_KEY', 'REPLACE_WITH_CACHE_PATH'] },
    save: { yaml: '- uses: actions/cache/restore@v4.0.2\n  with:\n    key: REPLACE_WITH_CACHE_KEY\n    path: REPLACE_WITH_CACHE_PATH\n- uses: actions/cache/save@v4.0.2\n  with:\n    key: REPLACE_WITH_CACHE_KEY\n    path: REPLACE_WITH_CACHE_PATH\n', names: ['REPLACE_WITH_CACHE_KEY', 'REPLACE_WITH_CACHE_PATH'] },
    package: { yaml: '- uses: actions/setup-node@v4.0.4\n  with:\n    cache: npm\n    cache-dependency-path: REPLACE_WITH_LOCKFILE_PATH\n- run: npm ci\n', names: ['REPLACE_WITH_LOCKFILE_PATH'] },
};
export function makeSuggestions(base: BaseReport): Result<Suggestion[]> {
    const output: Suggestion[] = [];
    for (const [name, t] of Object.entries(templates)) {
        const findings = base.findings.filter(f => name === 'key' ? ['KEY_DIFFERENT', 'DATE_SEGMENT_CHANGED', 'DYNAMIC_KEY_PENDING'].includes(f.code) : name === 'lockfile' ? f.code.startsWith('LOCKFILE_') : name === 'path' ? f.code.startsWith('PATH_CHANGE_') || f.code.startsWith('RESOLVED_PATH_') || f.code.startsWith('CACHE_VERSION_') : name === 'save' ? f.code.startsWith('RESTORE_ONLY_') || f.code.startsWith('SAVE_') : f.code.startsWith('PACKAGE_CACHE_'));
        if (!findings.length)
            continue;
        const findingIds = findings.map(f => f.id);
        output.push({ id: id('suggestion', [name, findingIds]), findingIds, title: { code: 'SUGGEST_' + name.toUpperCase(), params: [] }, yaml: staticText(t.yaml), placeholders: t.names.map(n => ({ name: n, required: true, explanation: { code: 'FILL_' + n, params: [] } })), evidenceRefs: [...new Map(findings.flatMap(f => f.evidenceRefs).map(r => [JSON.stringify(r), r])).values()] });
    }
    return ok(output);
}

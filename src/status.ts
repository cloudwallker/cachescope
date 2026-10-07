import type { Report, Result } from './model.ts';
export function exitCode(result: Result<Report> | Report): 0 | 1 | 2 | 3 {
    if ('ok' in result) {
        if (!result.ok)
            return 3;
        return exitCode(result.value);
    }
    if (result.diagnostics.some(d => ['invalid', 'io', 'limit'].includes(d.category)))
        return 3;
    if (result.diagnostics.some(d => ['incomplete', 'unverified', 'conflict'].includes(d.category)) || result.associations.steps.some(s => s.inScope && s.status !== 'unique') || result.comparisons.some(c => c.state === 'unknown' || c.state === 'conflict') || result.findings.some(f => f.kind === 'pending' || f.certainty !== 'confirmed'))
        return 2;
    return result.findings.some(f => f.kind === 'problem' && f.certainty === 'confirmed') ? 1 : 0;
}

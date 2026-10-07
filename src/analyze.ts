import type { AnalysisInputs, BaseReport, Report, Result, Selection, SourceRef, Observation, Diagnostic } from './model.ts';
import { assertTrustedInputs } from './input.ts';
import { associateSteps } from './associate.ts';
import { evaluateRules, uniqueRefs } from './rules.ts';
import { makeSuggestions } from './suggestions.ts';
import { ok, fail, freeze, LIMITS } from './safety.ts';
const trustedReports = new WeakSet<Report>();
export function assertTrustedReport(report: Report): Result<null> { return trustedReports.has(report) ? ok(null) : fail('REPORT_UNTRUSTED', 'render'); }
export function analyzeInputs(inputs: AnalysisInputs, selection?: Selection): Result<Report> {
    const trusted = assertTrustedInputs(inputs);
    if (!trusted.ok)
        return trusted;
    const association = associateSteps(inputs, selection);
    if (!association.ok)
        return association;
    const rules = evaluateRules(inputs, association.value);
    if (!rules.ok)
        return rules;
    const scoped = association.value.steps.filter(s => s.inScope), calculatedSteps = inputs.workflow.steps.filter(s => scoped.some(a => a.stepRef === s.stepRef));
    const associations = { ...association.value, steps: scoped };
    const blockIds = new Set(scoped.flatMap(s => [...s.runA, ...s.runB].flatMap(c => [c.mainBlockId, ...c.postBlockIds, ...c.saveBlockIds])));
    const observations: Observation[] = inputs.runs.flatMap(r => r.observations.filter(o => o.blockId && blockIds.has(o.blockId)));
    const supportRefs = new Set([...scoped.flatMap(s => [...s.runA, ...s.runB].flatMap(c => c.saveStepRefs)), ...observations.flatMap(o => o.stepRef ? [o.stepRef] : [])]);
    const steps = inputs.workflow.steps.filter(s => calculatedSteps.includes(s) || supportRefs.has(s.stepRef));
    if ([...supportRefs].some(ref => !steps.some(s => s.stepRef === ref)))
        return fail('REPORT_REFERENCE_INVALID', 'analysis');
    for (const sa of scoped)
        for (const c of [...sa.runA, ...sa.runB]) {
            const run = inputs.runs.find(r => r.runId === c.runId)!;
            const main = run.blocks.find(b => b.id === c.mainBlockId);
            if (!main || main.phase !== 'main' || main.runId !== c.runId || main.range.sourceId !== run.sourceId || c.postBlockIds.some(b => !run.blocks.some(x => x.id === b && x.phase === 'post')) || c.saveBlockIds.some(b => !run.blocks.some(x => x.id === b && x.phase === 'save')))
                return fail('REPORT_REFERENCE_INVALID', 'analysis');
        }
    const ranges = inputs.runs.flatMap(r => r.blocks.filter(b => blockIds.has(b.id)).map(b => b.range));
    const relevant = (d: Diagnostic) => d.stepRef !== undefined ? steps.some(s => s.stepRef === d.stepRef) : d.refs.length === 0 || d.refs.some(ref => [...steps.map(s => s.range), ...ranges].some(r => r.sourceId === ref.sourceId && r.startLine <= ref.endLine && ref.startLine <= r.endLine));
    const diagnostics = [...new Map([...inputs.diagnostics, ...inputs.workflow.diagnostics, ...inputs.runs.flatMap(r => r.diagnostics), ...(inputs.context?.diagnostics ?? []), ...(inputs.cacheList?.diagnostics ?? []), ...associations.diagnostics, ...rules.value.diagnostics].filter(relevant).map(d => [d.id, d])).values()];
    const base: BaseReport = { schemaVersion: 1, profile: inputs.profile, sources: [], excerpts: [], selectedSteps: associations.selectedSteps, associations, observations, steps, stepViews: calculatedSteps.map(s => ({ stepRef: s.stepRef, association: scoped.find(a => a.stepRef === s.stepRef)!, comparisonIds: rules.value.comparisons.filter(c => c.stepRef === s.stepRef).map(c => c.id), findingIds: rules.value.findings.filter(f => f.stepRef === s.stepRef).map(f => f.id), diagnosticIds: diagnostics.filter(d => d.stepRef === s.stepRef || d.refs.some(r => r.sourceId === s.range.sourceId && r.startLine <= s.range.endLine && s.range.startLine <= r.endLine)).map(d => d.id) })), ...rules.value, diagnostics, ...(inputs.cacheList ? { cacheList: inputs.cacheList } : {}) };
    const suggestions = makeSuggestions(base);
    if (!suggestions.ok)
        return suggestions;
    const report: Report = { ...base, findings: base.findings.map(f => { const suggestion = suggestions.value.find(s => s.findingIds.includes(f.id)); return { ...f, ...(suggestion ? { suggestionId: suggestion.id } : {}) }; }), suggestions: suggestions.value };
    const refs: SourceRef[] = [];
    const walk = (v: unknown): void => {
        if (!v || typeof v !== 'object')
            return;
        if ('sourceId' in v && 'startLine' in v && 'endLine' in v)
            refs.push(v as SourceRef);
        for (const x of Object.values(v))
            walk(x);
    };
    walk({ ...report, profile: null });
    const referenced = uniqueRefs(refs);
    report.excerpts = inputs.excerpts.filter(e => referenced.some(r => e.ref.sourceId === r.sourceId && (r.jsonPointer !== undefined ? e.ref.jsonPointer === r.jsonPointer || e.ref.jsonPointer?.startsWith(r.jsonPointer + '/') : e.ref.startLine <= r.endLine && r.startLine <= e.ref.endLine)));
    report.sources = inputs.sources.filter(s => referenced.some(r => r.sourceId === s.id) || report.excerpts.some(e => e.ref.sourceId === s.id));
    const sources = new Map(report.sources.map(s => [s.id, s]));
    if (referenced.some(r => !sources.has(r.sourceId) || r.startLine < 1 || r.endLine < r.startLine || r.endLine > sources.get(r.sourceId)!.lineCount || [r.startLine, r.endLine].some(line => !report.excerpts.some(e => e.ref.sourceId === r.sourceId && e.lines.some(l => l.line === line && l.parts.length)))))
        return fail('REPORT_REFERENCE_INVALID', 'analysis');
    const obsIds = new Set(observations.map(o => o.id)), findingIds = new Set(report.findings.map(f => f.id)), suggestionIds = new Set(report.suggestions.map(s => s.id));
    const stepIds = new Set(steps.map(s => s.stepRef)), comparisonIds = new Set(report.comparisons.map(c => c.id)), diagnosticIds = new Set(diagnostics.map(d => d.id));
    if (report.selectedSteps.some(s => !stepIds.has(s)) || observations.some(o => o.stepRef !== undefined && !stepIds.has(o.stepRef)) || [...report.comparisons, ...report.findings].some(c => !stepIds.has(c.stepRef)) || report.stepViews.some(v => !stepIds.has(v.stepRef) || v.comparisonIds.some(x => !comparisonIds.has(x)) || v.findingIds.some(x => !findingIds.has(x)) || v.diagnosticIds.some(x => !diagnosticIds.has(x))) || scoped.some(s => s.selected && (!s.runA.some(c => c.id === s.selected!.runACandidateId) || !s.runB.some(c => c.id === s.selected!.runBCandidateId))))
        return fail('REPORT_REFERENCE_INVALID', 'analysis');
    if (report.comparisons.some(c => c.a.observationIds.concat(c.b.observationIds).some(x => !obsIds.has(x))) || report.findings.some(f => f.observationIds.some(x => !obsIds.has(x)) || f.suggestionId !== undefined && !suggestionIds.has(f.suggestionId)) || report.suggestions.some(s => s.findingIds.some(x => !findingIds.has(x))))
        return fail('REPORT_REFERENCE_INVALID', 'analysis');
    if (Buffer.byteLength(JSON.stringify(report)) > LIMITS.json)
        return fail('REPORT_JSON_LIMIT', 'analysis', 'limit');
    freeze(report);
    trustedReports.add(report);
    return ok(report);
}

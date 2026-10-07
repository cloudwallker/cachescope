import type { AnalysisInputs, AssociationResult, Comparison, ComparisonSide, Field, Finding, KeyLayout, MissingEvidence, Observation, Result, RunCandidate, RunId, SourceRef, WorkflowStep, Diagnostic } from './model.ts';
import { ok, id, diagnostic } from './safety.ts';
type Findings = Omit<Finding, 'suggestionId'>[];
const compareFields: Comparison['field'][] = ['primaryKey', 'restoreKeys', 'runnerOS', 'resolvedPaths', 'ref'];
const missingNames: Partial<Record<Field, string>> = { primaryKey: 'PRIMARY_KEY', restoreKeys: 'RESTORE_KEYS', runnerOS: 'RUNNER_OS', resolvedPaths: 'RESOLVED_PATHS', ref: 'REF', keyLayout: 'KEY_LAYOUT', lockfileHash: 'LOCKFILE_HASH', cacheVersion: 'CACHE_VERSION', restoredKey: 'RESTORED_KEY' };
export function uniqueRefs(refs: SourceRef[]): SourceRef[] { return [...new Map(refs.map(r => [JSON.stringify(r), r])).values()]; }
function normalized(field: Field, value: unknown): unknown { return field === 'resolvedPaths' && Array.isArray(value) ? [...new Set(value)].sort() : value; }
function consensus(values: Observation[], field: Field): {
    state: 'value' | 'empty' | 'unknown' | 'conflict';
    value?: unknown;
} {
    const usable = values.filter(o => o.value.state === 'value' || o.value.state === 'empty');
    const forms = new Map(usable.map(o => [JSON.stringify(o.value.state === 'empty' ? { state: 'empty' } : { state: 'value', value: normalized(field, o.value.state === 'value' ? o.value.value : null) }), o]));
    if (forms.size > 1 || values.some(o => o.status === 'conflict'))
        return { state: 'conflict' };
    if (!usable.length || values.some(o => o.value.state === 'masked'))
        return { state: 'unknown' };
    const o = usable[0]!;
    return o.value.state === 'value' ? { state: 'value', value: normalized(field, o.value.value) } : { state: 'empty' };
}
function candidates(a: AssociationResult, stepRef: string, runId: RunId): RunCandidate[] { const s = a.steps.find(s => s.stepRef === stepRef)!; return runId === 'a' ? s.runA : s.runB; }
export function mainObservations(inputs: AnalysisInputs, a: AssociationResult, stepRef: string, runId: RunId): Observation[] { const blocks = new Set(candidates(a, stepRef, runId).map(c => c.mainBlockId)); return inputs.runs.find(r => r.runId === runId)!.observations.filter(o => o.blockId !== undefined && blocks.has(o.blockId)); }
function mainUnique(a: AssociationResult, stepRef: string, runId: RunId): boolean { const c = candidates(a, stepRef, runId); return c.length === 1 && c[0]!.mainStatus === 'unique'; }
function side(inputs: AnalysisInputs, a: AssociationResult, s: WorkflowStep, runId: RunId, field: Field): ComparisonSide {
    const values = mainObservations(inputs, a, s.stepRef, runId).filter(o => o.field === field);
    const user = values.some(o => o.origin === 'user_provided'), actual = values.some(o => o.origin !== 'user_provided');
    return { runId, observationIds: values.map(o => o.id), values, basis: user && actual ? 'mixed' : user ? 'user_provided' : actual ? 'actual' : 'missing' };
}
function difference(a: string, b: string): Comparison['differences'] {
    const x = Array.from(a), y = Array.from(b);
    let start = 0, endA = x.length, endB = y.length;
    while (start < endA && start < endB && x[start] === y[start])
        start++;
    while (endA > start && endB > start && x[endA - 1] === y[endB - 1]) {
        endA--;
        endB--;
    }
    return start === endA && start === endB ? [] : [{ aStart: start, aEnd: endA, bStart: start, bEnd: endB }];
}
function compare(inputs: AnalysisInputs, a: AssociationResult, s: WorkflowStep, field: Comparison['field']): Comparison {
    const left = side(inputs, a, s, 'a', field), right = side(inputs, a, s, 'b', field), x = consensus(left.values, field), y = consensus(right.values, field);
    const unique = mainUnique(a, s.stepRef, 'a') && mainUnique(a, s.stepRef, 'b');
    const state = !unique ? 'unknown' : x.state === 'conflict' || y.state === 'conflict' ? 'conflict' : x.state === 'unknown' || y.state === 'unknown' ? 'unknown' : JSON.stringify(x) === JSON.stringify(y) ? 'same' : 'different';
    const missingEvidence: MissingEvidence[] = [];
    for (const [runId, v] of [['a', x], ['b', y]] as const) {
        if (!mainUnique(a, s.stepRef, runId))
            missingEvidence.push({ code: 'RUN_ASSOCIATION', runId, stepRef: s.stepRef });
        if (v.state === 'unknown')
            missingEvidence.push({ code: missingNames[field]!, field, runId, stepRef: s.stepRef });
    }
    return { id: id('comparison', [s.stepRef, field]), stepRef: s.stepRef, field, a: left, b: right, state, evidenceRefs: uniqueRefs([...left.values, ...right.values].flatMap(o => o.refs)), differences: state === 'different' && typeof x.value === 'string' && typeof y.value === 'string' ? difference(x.value, y.value) : [], missingEvidence };
}
function validLayout(value: unknown, key: string): {
    kind: string;
    text: string;
    expression?: string;
    refs: SourceRef[];
}[] | null {
    const layout = value as KeyLayout;
    let at = 0;
    const out: {
        kind: string;
        text: string;
        expression?: string;
        refs: SourceRef[];
    }[] = [];
    for (const p of layout.parts) {
        const start = p.kind === 'literal' ? p.keyStart : p.variable.keyStart, end = p.kind === 'literal' ? p.keyEnd : p.variable.keyEnd;
        const text = p.kind === 'literal' ? p.text : p.variable.resolved;
        if (start !== at || end <= start || text.state !== 'value' || Array.from(text.value).length !== end - start)
            return null;
        if (p.kind === 'variable') {
            if (p.variable.expression.state !== 'value' || !p.variable.refs.length)
                return null;
            out.push({ kind: p.variable.kind, text: text.value, expression: p.variable.expression.value, refs: p.variable.refs });
        }
        else
            out.push({ kind: 'literal', text: text.value, refs: [] });
        at = end;
    }
    return at === Array.from(key).length && out.map(p => p.text).join('') === key ? out : null;
}
export function evaluateRules(inputs: AnalysisInputs, association: AssociationResult): Result<{
    comparisons: Comparison[];
    findings: Findings;
    diagnostics: Diagnostic[];
}> {
    const comparisons: Comparison[] = [], findings: Findings = [], diagnostics: Diagnostic[] = [];
    for (const s of inputs.workflow.steps.filter(s => association.steps.some(a => a.stepRef === s.stepRef && a.inScope))) {
        const sa = association.steps.find(a => a.stepRef === s.stepRef)!, cs = compareFields.map(f => compare(inputs, association, s, f));
        comparisons.push(...cs);
        const main = ['a', 'b'].flatMap(r => mainObservations(inputs, association, s.stepRef, r as RunId));
        const obs = (runId: RunId, field: Field) => main.filter(o => o.runId === runId && o.field === field);
        const pair = (field: Field) => [consensus(obs('a', field), field), consensus(obs('b', field), field)] as const;
        const known = s.actionRefRefs.length > 0 && s.actionRefRefs.every(ref => inputs.excerpts.some(e => e.ref.sourceId === ref.sourceId && e.lines.some(l => l.line >= ref.startLine && l.line <= ref.endLine && l.parts.some(p => p.startColumn < p.endColumn)))) && s.actionRef.state === 'value' && inputs.profile.entries.some(e => e.actionKind === s.actionKind && e.declaredRefs.includes(s.actionRef.state === 'value' ? s.actionRef.value : ''));
        const unique = mainUnique(association, s.stepRef, 'a') && mainUnique(association, s.stepRef, 'b');
        const add = (code: string, kind: Finding['kind'], certainty: Finding['certainty'], evidence: Observation[] = [], refs: SourceRef[] = [], missingEvidence: MissingEvidence[] = [], messageCode = code) => { const evidenceRefs = uniqueRefs([...refs, ...evidence.flatMap(o => o.refs)]); findings.push({ id: id('finding', [s.stepRef, code, evidenceRefs]), stepRef: s.stepRef, code, kind, certainty, evidenceRefs, observationIds: evidence.map(o => o.id), missingEvidence, message: { code: messageCode, params: [] } }); };
        const miss = (code: string, field?: Field): MissingEvidence => ({ code, stepRef: s.stepRef, ...(field ? { field } : {}) });
        if (sa.status !== 'unique')
            add('RUN_ASSOCIATION_PENDING', 'pending', sa.status === 'missing' ? 'unknown' : sa.status, [], s.actionRefRefs, sa.missingEvidence);
        if (!known) {
            const d = diagnostic('ACTION_REF_UNVERIFIED', 'analysis', 'unverified', s.actionRefRefs);
            diagnostics.push({ ...d, stepRef: s.stepRef });
        }
        const key = s.inputs.find(i => i.name === 'key'), keyComparison = cs[0]!;
        if (keyComparison.state === 'different' && known)
            add('KEY_DIFFERENT', 'fact', 'confirmed', [...keyComparison.a.values, ...keyComparison.b.values], [], [], keyComparison.a.basis === 'actual' && keyComparison.b.basis === 'actual' ? 'KEY_DIFFERENT' : 'KEY_DIFFERENT_USER_DECLARED');
        if (key?.form !== 'literal' && key !== undefined || keyComparison.state === 'different' && !known) {
            const [ka, kb] = pair('primaryKey'), [la, lb] = pair('keyLayout'), [ha, hb] = pair('lockfileHash');
            const needs: MissingEvidence[] = [];
            for (const [field, p] of [['primaryKey', [ka, kb]], ['keyLayout', [la, lb]], ['lockfileHash', [ha, hb]]] as const)
                if (p.some(x => x.state !== 'value'))
                    needs.push(miss(missingNames[field]!, field));
            const x = ka.state === 'value' && la.state === 'value' ? validLayout(la.value, ka.value as string) : null, y = kb.state === 'value' && lb.state === 'value' ? validLayout(lb.value, kb.value as string) : null;
            if (!x || !y) {
                if (!needs.some(m => m.code === 'KEY_LAYOUT'))
                    needs.push(miss('KEY_LAYOUT', 'keyLayout'));
                needs.push(miss('VARIABLE_VALUE', 'keyLayout'));
            }
            const date = known && unique && keyComparison.state === 'different' && ha.state === 'value' && hb.state === 'value' && ha.value === hb.value && x && y && x.length === y.length && x.some((p, i) => p.kind === 'date' && p.text !== y[i]!.text) && x.every((p, i) => p.kind === y[i]!.kind && p.expression === y[i]!.expression && (p.kind === 'date' || p.text === y[i]!.text)) && x.filter(p => p.expression).every(p => key?.expressions.some(e => e.text.state === 'value' && e.text.value === p.expression));
            if (date)
                add('DATE_SEGMENT_CHANGED', 'fact', 'confirmed', main.filter(o => ['primaryKey', 'keyLayout', 'lockfileHash'].includes(o.field)), key!.refs, [], 'DATE_SEGMENT_CHANGED_USER_DECLARED');
            else {
                if (!known)
                    needs.push(miss('EXECUTION_COMMIT'));
                if (!unique)
                    needs.push(miss('RUN_ASSOCIATION'));
                add('DYNAMIC_KEY_PENDING', 'pending', keyComparison.state === 'conflict' ? 'conflict' : !main.some(o => ['primaryKey', 'keyLayout', 'lockfileHash'].includes(o.field)) ? 'candidate' : 'unknown', main.filter(o => ['primaryKey', 'keyLayout', 'lockfileHash'].includes(o.field)), key?.refs ?? [], needs);
            }
        }
        const path = s.inputs.find(i => i.name === 'path'), pc = cs[3]!;
        if (path || s.actionKind === 'setup-node') {
            if (pc.state === 'different' && known)
                add('RESOLVED_PATH_CHANGED', 'fact', 'confirmed', [...pc.a.values, ...pc.b.values], [], [], pc.a.basis === 'actual' && pc.b.basis === 'actual' ? 'RESOLVED_PATH_CHANGED' : 'RESOLVED_PATH_CHANGED_USER_DECLARED');
            else if (pc.state === 'unknown' || pc.state === 'conflict' || !known)
                add('PATH_CHANGE_PENDING', 'pending', pc.state === 'conflict' ? 'conflict' : 'unknown', [...pc.a.values, ...pc.b.values], path?.refs ?? [], [...pc.missingEvidence, ...(!known ? [miss('EXECUTION_COMMIT')] : [])]);
        }
        const versionEvidence = main.filter(o => o.field === 'cacheVersion');
        if (versionEvidence.length || pc.state === 'different') {
            const [va, vb] = pair('cacheVersion');
            if (known && unique && va.state === 'value' && vb.state === 'value' && va.value !== vb.value)
                add('CACHE_VERSION_DIFFERENT', 'fact', 'confirmed', versionEvidence, [], [], 'CACHE_VERSION_DIFFERENT_USER_DECLARED');
            else if (va.state !== 'value' || vb.state !== 'value' || !known || !unique)
                add('CACHE_VERSION_PENDING', 'pending', va.state === 'conflict' || vb.state === 'conflict' ? 'conflict' : 'unknown', versionEvidence, [], [miss('CACHE_VERSION', 'cacheVersion'), ...(!known ? [miss('EXECUTION_COMMIT')] : []), ...(!unique ? [miss('RUN_ASSOCIATION')] : [])]);
        }
        const dependency = s.inputs.find(i => i.name === 'cache-dependency-path'), errors = main.filter(o => o.field === 'lockfileError');
        if (dependency || errors.length) {
            let found = false;
            for (const runId of ['a', 'b'] as const) {
                const list = obs(runId, 'lockfileError'), c = consensus(list, 'lockfileError');
                if (known && unique && c.state === 'value' && list.some(o => o.origin === 'log' && o.verification === 'verified')) {
                    const error = c.value as {
                        path: string;
                        pathBasis: string;
                    };
                    if (dependency?.form === 'literal' && dependency.value.state === 'value' && dependency.value.value === error.path) {
                        add('LOCKFILE_NOT_RESOLVED', 'problem', 'confirmed', list, dependency.refs, [], error.pathBasis === 'action-input' ? 'LOCKFILE_NOT_RESOLVED_ACTION_INPUT' : 'LOCKFILE_NOT_RESOLVED');
                        found = true;
                        break;
                    }
                }
            }
            if (!found)
                add('LOCKFILE_PATH_PENDING', 'pending', errors.some(o => o.status === 'conflict') ? 'conflict' : 'unknown', errors, dependency?.refs ?? [], [miss('EXECUTION_COMMIT'), miss('LOCKFILE_ERROR', 'lockfileError')]);
        }
        if (s.actionKind === 'restore' && !sa.runA.concat(sa.runB).some(c => c.saveStepRefs.length))
            add('RESTORE_ONLY_CONFIG', 'fact', 'confirmed', [], s.actionRefRefs);
        if (['cache', 'restore', 'setup-node', 'save'].includes(s.actionKind)) {
            const missing: MissingEvidence[] = [];
            const saveEvidence: Observation[] = [];
            let certainty: Finding['certainty'] = 'unknown';
            for (const runId of ['a', 'b'] as const) {
                const cand = candidates(association, s.stepRef, runId);
                if (cand.length !== 1 || cand[0]!.saveStatus !== 'unique') {
                    missing.push({ ...miss('POST_BOUNDARY'), runId }, { ...miss('SAVE_RESULT', 'saveOutcome'), runId });
                    if (cand.some(c => c.saveStatus === 'conflict'))
                        certainty = 'conflict';
                    continue;
                }
                const blocks = inputs.runs.find(r => r.runId === runId)!.blocks.filter(b => cand[0]!.postBlockIds.concat(cand[0]!.saveBlockIds).includes(b.id));
                const ev = inputs.runs.find(r => r.runId === runId)!.observations.filter(o => o.blockId && blocks.some(b => b.id === o.blockId) && ['saveOutcome', 'saveReason'].includes(o.field));
                saveEvidence.push(...ev);
                const outcomes = ev.filter(o => o.field === 'saveOutcome'), reasons = ev.filter(o => o.field === 'saveReason');
                const outcome = consensus(outcomes, 'saveOutcome'), reason = consensus(reasons, 'saveReason');
                if (outcome.state === 'conflict' || reason.state === 'conflict') {
                    certainty = 'conflict';
                    missing.push({ ...miss('SAVE_RESULT', outcome.state === 'conflict' ? 'saveOutcome' : 'saveReason'), runId });
                }
                // Current fixed profile has no runner completion boundary or failure/denied pattern.
                if (!blocks.every(b => b.completeness.state === 'complete' && b.completeness.basis === 'runner-boundaries'))
                    missing.push({ ...miss('POST_BOUNDARY'), runId });
                if (outcome.state !== 'value' && outcome.state !== 'conflict')
                    missing.push({ ...miss('SAVE_RESULT', 'saveOutcome'), runId });
                if (outcome.state === 'value' && outcome.value === 'skipped' && reason.state === 'value' && (reason.value as { class: string }).class === 'normal-policy' && outcomes.some(o => o.origin === 'log' && o.verification === 'verified' && o.status === 'confirmed' && o.value.state === 'value') && reasons.some(o => o.origin === 'log' && o.verification === 'verified' && o.status === 'confirmed' && o.value.state === 'value'))
                    add('SAVE_SKIPPED_NORMAL_POLICY', 'fact', 'confirmed', ev, blocks.flatMap(b => b.completeness.refs));
            }
            if (missing.length)
                add('SAVE_OUTCOME_PENDING', 'pending', certainty, saveEvidence, s.actionRefRefs, missing);
        }
        if (s.actionKind === 'setup-node') {
            const cache = s.inputs.find(i => i.name === 'cache'), managers = ['npm', 'yarn', 'pnpm'];
            const explicit = cache?.value.state === 'value' && cache.form === 'literal' && managers.includes(cache.value.value) ? cache.value.value : undefined;
            const restored = main.filter(o => o.field === 'restoredKey'), restoreOK = (['a', 'b'] as const).every(r => { const v = consensus(obs(r, 'restoredKey'), 'restoredKey'); return v.state === 'value' && obs(r, 'restoredKey').some(o => o.origin === 'log' && o.verification === 'verified'); });
            const independentlyVerified = (runId: RunId, field: Field) => obs(runId, field).some(o => o.value.state === 'value' && o.origin === 'log' && o.verification === 'verified' && o.status === 'confirmed');
            const enablement = pair('cacheEnabled'), pm = pair('packageManager');
            const enabled = (['a', 'b'] as const).every((r, index) => enablement[index]!.state === 'value' && enablement[index]!.value === true && independentlyVerified(r, 'cacheEnabled'));
            const manager = explicit ?? (pm[0].state === 'value' && pm[1].state === 'value' && pm[0].value === pm[1].value && (['a', 'b'] as const).every(r => independentlyVerified(r, 'packageManager')) ? String(pm[0].value) : undefined);
            const installs = inputs.workflow.installSteps.filter(i => i.jobIndex === s.jobIndex && i.packageManager === manager);
            const packageEvidence = main.filter(o => ['cacheEnabled', 'packageManager'].includes(o.field));
            const packageConflict = enablement.some(p => p.state === 'conflict') || pm.some(p => p.state === 'conflict' || explicit && p.state === 'value' && p.value !== explicit) || packageEvidence.some(o => o.field === 'cacheEnabled' && o.value.state === 'value' && o.value.value === false && explicit);
            if (known && unique && !packageConflict && (explicit || enabled) && manager && restoreOK && installs.length)
                add('PACKAGE_CACHE_OBJECT', 'fact', 'confirmed', [...restored, ...packageEvidence], [...(cache?.refs ?? []), ...installs.map(i => i.range)]);
            else {
                const missing: MissingEvidence[] = [];
                if (!(explicit || enabled) || !manager || packageConflict)
                    missing.push(miss('CACHE_ENABLEMENT', 'cacheEnabled'));
                if (!restoreOK)
                    missing.push(miss('RESTORED_KEY', 'restoredKey'));
                if (!installs.length)
                    missing.push(miss('INSTALL_STEP'));
                if (!known)
                    missing.push(miss('EXECUTION_COMMIT'));
                add('PACKAGE_CACHE_PENDING', 'pending', packageConflict || restored.some(o => o.status === 'conflict') ? 'conflict' : 'unknown', [...restored, ...packageEvidence], cache?.refs ?? [], missing);
            }
        }
    }
    return ok({ comparisons, findings, diagnostics });
}

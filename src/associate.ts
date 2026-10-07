import type { AnalysisInputs, Selection, Result, AssociationResult, WorkflowStep, RunCandidate, StepAssociation, ParsedRun, ContextStep, MissingEvidence } from './model.ts';
import { assertTrustedInputs, targetsStep } from './input.ts';
import { fail, ok, id, safeString, object, diagnostic } from './safety.ts';
function candidates(inputs: AnalysisInputs, step: WorkflowStep, run: ParsedRun): RunCandidate[] {
    const context = inputs.context?.steps.filter(c => c.runId === run.runId && targetsStep(c.target, step)) ?? [];
    const result: RunCandidate[] = [];
    for (const cs of context) {
        const isAmbiguous = inputs.workflow.steps.filter(s => targetsStep(cs.target, s)).length !== 1;
        const mains = cs.regions.filter(r => r.phase === 'main');
        for (const region of mains) {
            const block = run.blocks.find(b => b.range.startLine === region.range.startLine && b.range.endLine === region.range.endLine && b.phase === 'main' && (b.stepIndex.state !== 'value' || b.stepIndex.value === step.stepIndex) && (b.jobId.state !== 'value' || step.jobId.state === 'value' && step.jobId.value === b.jobId.value));
            if (!block)
                continue;
            const posts = run.blocks.filter(b => b.phase === 'post' && b.parentCandidates.includes(block.id));
            const saveTargets = cs.saveTargets.flatMap(t => inputs.workflow.steps.filter(s => targetsStep(t.target, s)));
            const saveStepRefs = [...new Set(saveTargets.map(s => s.stepRef))];
            const saves = run.blocks.filter(b => b.phase === 'save' && inputs.context?.steps.some(s => s.runId === run.runId && saveTargets.some(t => targetsStep(s.target, t)) && s.regions.some(r => r.range.startLine === b.range.startLine && r.range.endLine === b.range.endLine && r.phase === 'save')));
            const mainConflict = region.completeness.state === 'conflict' || block.completeness.state === 'conflict';
            const mainStatus = mainConflict ? 'conflict' : isAmbiguous ? 'ambiguous' : 'unique';
            let saveStatus: RunCandidate['saveStatus'] = posts.length + saves.length === 0 ? 'missing' : posts.length > 1 || saves.length > 1 || posts.some(b => b.parentCandidates.length !== 1) ? 'ambiguous' : 'unique';
            if (posts.some(b => b.completeness.state === 'conflict' || b.stepIndex.state === 'value' && b.stepIndex.value !== step.stepIndex || b.jobId.state === 'value' && step.jobId.state === 'value' && b.jobId.value !== step.jobId.value || b.actionKind.state === 'value' && b.actionKind.value !== step.actionKind) || saves.some(b => b.completeness.state === 'conflict') || saveTargets.some(s => s.actionKind !== 'save'))
                saveStatus = 'conflict';
            const mainKeys = run.observations.filter(o => o.blockId === block.id && o.field === 'primaryKey' && o.value.state === 'value').map(o => JSON.stringify(o.value));
            const saveKeys = run.observations.filter(o => (posts.some(b => b.id === o.blockId) || saves.some(b => b.id === o.blockId)) && o.field === 'primaryKey' && o.value.state === 'value').map(o => JSON.stringify(o.value));
            if (mainKeys.length && saveKeys.some(k => !mainKeys.includes(k)))
                saveStatus = 'conflict';
            const missingEvidence: MissingEvidence[] = [];
            if (mainStatus !== 'unique')
                missingEvidence.push({ code: 'RUN_ASSOCIATION', runId: run.runId, stepRef: step.stepRef });
            if (saveStatus === 'missing')
                missingEvidence.push({ code: 'POST_BOUNDARY', runId: run.runId, stepRef: step.stepRef }, { code: 'SAVE_RESULT', runId: run.runId, stepRef: step.stepRef });
            else if (saveStatus !== 'unique')
                missingEvidence.push({ code: 'SAVE_RESULT', runId: run.runId, stepRef: step.stepRef });
            const status = mainStatus === 'conflict' || saveStatus === 'conflict' ? 'conflict' : mainStatus === 'ambiguous' || saveStatus === 'ambiguous' ? 'ambiguous' : 'unique';
            result.push({ id: id('candidate', [step.stepRef, run.runId, block.id]), stepRef: step.stepRef, runId: run.runId, mainBlockId: block.id, postBlockIds: posts.map(b => b.id), saveStepRefs, saveBlockIds: saves.map(b => b.id), basis: 'context-range', refs: [...cs.refs, region.declarationRef], mainStatus, saveStatus, status, missingEvidence });
        }
    }
    if (result.length > 1)
        for (const r of result)
            if (r.mainStatus !== 'conflict') {
                r.mainStatus = 'ambiguous';
                r.status = r.saveStatus === 'conflict' ? 'conflict' : 'ambiguous';
            }
    return result;
}
export function associateSteps(inputs: AnalysisInputs, selection?: Selection): Result<AssociationResult> {
    const trusted = assertTrustedInputs(inputs);
    if (!trusted.ok)
        return trusted;
    const select = selection ?? {};
    if (!object(select) || Object.keys(select).some(k => !['jobId', 'step'].includes(k)) || select.jobId !== undefined && (typeof select.jobId !== 'string' || safeString(select.jobId).state !== 'value') || select.step !== undefined && (!object(select.step) || !['stepRef', 'stepId'].includes(String(select.step.kind)) || typeof select.step.value !== 'string' || Object.keys(select.step).some(k => !['kind', 'value'].includes(k))))
        return fail('SELECTION_INVALID', 'association');
    let scoped = inputs.workflow.steps;
    if (select.jobId !== undefined)
        scoped = scoped.filter(s => s.jobId.state === 'value' && s.jobId.value === select.jobId);
    if (select.step) {
        const q = select.step;
        const global = inputs.workflow.steps.filter(s => q.kind === 'stepRef' ? s.stepRef === q.value : s.stepId.state === 'value' && s.stepId.value === q.value);
        if (q.kind === 'stepRef' && global.length && select.jobId !== undefined && !scoped.includes(global[0]!))
            return fail('SELECTION_CONFLICT', 'association', 'conflict');
        scoped = scoped.filter(s => global.includes(s));
        if (scoped.length > 1)
            return fail('SELECTION_AMBIGUOUS', 'association', 'incomplete');
    }
    if ((select.jobId !== undefined || select.step !== undefined) && scoped.length === 0)
        return fail('SELECTION_NOT_FOUND', 'association');
    const out: AssociationResult = { selection: { ...(select.jobId === undefined ? {} : { jobId: select.jobId }), ...(select.step === undefined ? {} : { step: { ...select.step } }) } as Selection, selectedSteps: scoped.map(s => s.stepRef), steps: [], diagnostics: [] };
    for (const step of inputs.workflow.steps) {
        const inScope = scoped.includes(step);
        const runA = inScope ? candidates(inputs, step, inputs.runs[0]) : [], runB = inScope ? candidates(inputs, step, inputs.runs[1]) : [];
        let status: StepAssociation['status'] = 'missing';
        if (runA.some(c => c.status === 'conflict') || runB.some(c => c.status === 'conflict'))
            status = 'conflict';
        else if (runA.some(c => c.status === 'ambiguous') || runB.some(c => c.status === 'ambiguous') || runA.length > 1 || runB.length > 1)
            status = 'ambiguous';
        else if (runA.length === 1 && runB.length === 1)
            status = 'unique';
        const sa: StepAssociation = { stepRef: step.stepRef, inScope, runA, runB, status, missingEvidence: [...runA.flatMap(c => c.missingEvidence), ...runB.flatMap(c => c.missingEvidence)] };
        if (inScope) {
            if (!runA.length)
                sa.missingEvidence.push({ code: 'RUN_ASSOCIATION', runId: 'a', stepRef: step.stepRef });
            if (!runB.length)
                sa.missingEvidence.push({ code: 'RUN_ASSOCIATION', runId: 'b', stepRef: step.stepRef });
            if (runA.length === 1 && runB.length === 1 && runA[0]!.mainStatus === 'unique' && runB[0]!.mainStatus === 'unique')
                sa.selected = { runACandidateId: runA[0]!.id, runBCandidateId: runB[0]!.id };
        }
        out.steps.push(sa);
    }
    return ok(out);
}

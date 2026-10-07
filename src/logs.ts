import type { Id, Result, ParsedRun, RunId, Context, LogBlock, Observation, LogPattern, Presence, Field, SourceRef } from './model.ts';
import type { ParseContext } from './input.ts';
import { validateParseContext, registeredWorkflow, registeredWorkflowActionRef, targetsStep } from './input.ts';
import { profile } from './profile.ts';
import { SafeFailure, LIMITS, check, id, diagnostic, stripAnsiLines, object, fields, staticText, safeString } from './safety.ts';
type Header = {
    path: Presence<any>;
    refs: SourceRef[];
    patternId: Id;
    action: string;
    endLine: number;
};
type HeaderConflict = {
    conflict: true;
    ref: SourceRef;
};
function canonicalAction(action: string): string | null {
    const at = action.lastIndexOf('@');
    if (at < 1)
        return null;
    const name = action.slice(0, at).replace(/[A-Z]/g, c => c.toLowerCase()), ref = action.slice(at + 1);
    if (!profile.entries.some(e => e.actionName === name) || safeString(ref).state !== 'value' || /\s/.test(ref))
        return null;
    return name + '@' + ref;
}
function exact(p: LogPattern, line: string): Record<string, string> | null {
    const pref = prefix(p, line);
    if (!pref)
        return null;
    const m = match(p, pref.line);
    return m.length === 1 && decode(p, m[0]!) ? m[0]! : null;
}
function evidenceAnchor(ctx: ParseContext, ref: SourceRef, start = 0, end = 0): void {
    const r = ctx.requestExcerpt(ref, [{ line: ref.startLine, startColumn: start, endColumn: end }]);
    if (!r.ok)
        throw new SafeFailure(r.diagnostics[0]!.code, r.diagnostics[0]!.category);
}
function inputHeader(ctx: ParseContext, sourceId: Id, region: Context['steps'][number]['regions'][number], lines: ReturnType<typeof stripAnsiLines>, action: string): Header | HeaderConflict | null {
    const ps = profile.patterns;
    const open = ps.find(p => p.role === 'block-open')!, withp = ps.find(p => p.role === 'input-component' && !p.outputs.length)!, dep = ps.find(p => p.outputs.some(o => o.field === 'dependencyPathInput'))!, close = ps.find(p => p.role === 'block-close')!;
    const at = region.range.startLine;
    if (lines.slice(at - 1, region.range.endLine).filter(l => exact(open, l.text)).length !== 1)
        return null;
    const first = exact(open, lines[at - 1]!.text);
    if (!first)
        return null;
    const actual = canonicalAction(first.action!);
    if (!actual)
        return null;
    if (actual !== canonicalAction(action)) {
        const ref = { sourceId, startLine: at, endLine: at };
        const dl = lines[at - 1]!, pref = prefix(open, dl.text)!;
        const start = Array.from(dl.text.slice(0, pref.removed + '##[group]Run '.length)).length;
        evidenceAnchor(ctx, ref, dl.columns[start]!, dl.columns[start + Array.from(first.action!).length - 1]! + 1);
        return { conflict: true, ref };
    }
    if (at + 1 > region.range.endLine || !exact(withp, lines[at]!.text))
        return null;
    const refs: SourceRef[] = [{ sourceId, startLine: at, endLine: at }, { sourceId, startLine: at + 1, endLine: at + 1 }];
    let captured: Presence<any> | undefined, depRef: SourceRef | undefined, endLine = 0;
    for (let line = at + 2; line <= region.range.endLine; line++) {
        const text = lines[line - 1]!.text;
        if (exact(close, text)) {
            endLine = line;
            break;
        }
        const plain = prefix(dep, text)!.line;
        if (!/^  [a-zA-Z][a-zA-Z0-9_-]*: [^\r\n]+$/.test(plain))
            return null;
        const m = exact(dep, text);
        if (m) {
            if (captured)
                return null;
            captured = safeString(m.path!);
            if (m.path!.trim() !== m.path)
                captured = { state: 'masked' };
            depRef = { sourceId, startLine: line, endLine: line };
        }
    }
    if (!endLine)
        return null;
    if (depRef)
        refs.push(depRef);
    refs.push({ sourceId, startLine: endLine, endLine: endLine });
    for (const r of refs)
        evidenceAnchor(ctx, r);
    // Only the needed safe input value enters an excerpt; no other input/env text.
    if (depRef && captured?.state === 'value') {
        const dl = lines[depRef.startLine - 1]!, pref = prefix(dep, dl.text)!;
        const before = Array.from(dl.text.slice(0, pref.removed + '  cache-dependency-path: '.length)).length;
        const start = dl.columns[before]!, end = dl.columns[before + Array.from(captured.value).length - 1]! + 1;
        evidenceAnchor(ctx, depRef, start, end);
    }
    return { path: captured ?? { state: 'missing' }, refs, patternId: dep.id, action, endLine };
}
function match(pattern: LogPattern, line: string): Record<string, string>[] {
    const matches: Record<string, string>[] = [];
    const segments = pattern.segments;
    const walk = (index: number, offset: number, captures: Record<string, string>) => {
        if (matches.length > 1)
            return;
        if (index === segments.length) {
            if (offset === line.length)
                matches.push(captures);
            return;
        }
        const s = segments[index]!;
        if ('literal' in s) {
            if (line.startsWith(s.literal, offset))
                walk(index + 1, offset + s.literal.length, captures);
            return;
        }
        const next = segments[index + 1];
        if (!next) {
            walk(index + 1, line.length, { ...captures, [s.capture]: line.slice(offset) });
            return;
        }
        if (!('literal' in next))
            throw new SafeFailure('PROFILE_CAPTURE_INVALID');
        let at = line.indexOf(next.literal, offset);
        while (at !== -1) {
            walk(index + 1, at, { ...captures, [s.capture]: line.slice(offset, at) });
            if (matches.length > 1)
                return;
            at = line.indexOf(next.literal, at + 1);
        }
    };
    walk(0, 0, {});
    return matches;
}
function decode(pattern: LogPattern, captures: Record<string, string>): Record<string, unknown> | null {
    const values: Record<string, unknown> = {};
    for (const s of pattern.segments) {
        if (!('capture' in s))
            continue;
        const raw = captures[s.capture]!;
        switch (s.codec) {
            case 'text':
                values[s.capture] = raw;
                break;
            case 'key':
                check(Array.from(raw).length, LIMITS.key, 'KEY_LIMIT');
                values[s.capture] = raw;
                break;
            case 'boolean':
                if (raw !== 'true' && raw !== 'false')
                    return null;
                values[s.capture] = raw === 'true';
                break;
            case 'sha40':
                if (!/^[a-f0-9]{40}$/i.test(raw))
                    return null;
                values[s.capture] = raw;
                break;
            case 'path-list':
                if (!s.separator)
                    return null;
                values[s.capture] = raw.split(s.separator);
                break;
            case 'save-outcome':
                if (!['saved', 'skipped', 'write-denied', 'error'].includes(raw))
                    return null;
                values[s.capture] = raw;
        }
    }
    return values;
}
function prefix(pattern: LogPattern, line: string): {
    line: string;
    removed: number;
} | null {
    if (pattern.acceptedPrefixes.includes('iso8601-space')) {
        const m = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z /.exec(line);
        if (m)
            return { line: line.slice(m[0].length), removed: m[0].length };
    }
    if (pattern.acceptedPrefixes.includes('runner-group') && line.startsWith('##[group]'))
        return { line: line.slice(10), removed: 10 };
    return pattern.acceptedPrefixes.includes('none') ? { line, removed: 0 } : null;
}
export function markConflicts(observations: Observation[]): void {
    const groups = new Map<string, Observation[]>();
    for (const o of observations) {
        const key = JSON.stringify([o.runId, o.stepRef, o.field]);
        const list = groups.get(key) ?? [];
        list.push(o);
        groups.set(key, list);
    }
    for (const list of groups.values()) {
        const useful = list.filter(o => o.value.state === 'empty' || o.value.state === 'value' && !(o.field === 'cacheHit' && o.value.value === 'unrecorded'));
        const keys = new Set(useful.map(o => JSON.stringify(o.value)));
        if (keys.size > 1)
            for (const o of useful)
                o.status = 'conflict';
    }
}
// input.ts supplies workflow identity while raw source is still held by its capability.
export function parseRunLog(ctx: ParseContext, sourceId: Id, runId: RunId, context?: Context): Result<ParsedRun> {
    const g = validateParseContext(ctx, sourceId, 'log');
    if (!g.ok)
        return g;
    const workflow = registeredWorkflow(ctx);
    return ctx.withSource(sourceId, (_text, offsets) => {
        const decodedLines = stripAnsiLines(offsets.lines);
        const parsed: ParsedRun = { runId, sourceId, blocks: [], observations: [], diagnostics: [] };
        const css = context?.steps.filter(s => s.runId === runId) ?? [];
        const byRegion = new Map<string, LogBlock>();
        for (const cs of css) {
            const matches = workflow.steps.filter(s => targetsStep(cs.target, s));
            const target = matches.length === 1 ? matches[0] : undefined;
            const targetRef = target?.actionRef.state === 'value' ? target.actionRef.value : undefined;
            const entry = targetRef ? profile.entries.find(e => e.actionKind === target!.actionKind && e.declaredRefs.includes(targetRef)) : undefined;
            const knownEntry = target ? profile.entries.find(e => e.actionKind === target.actionKind) : undefined;
            const action = knownEntry && targetRef ? knownEntry.actionName + '@' + targetRef : undefined;
            const repositoryAction = entry && targetRef ? entry.actionName.split('/').slice(0, 2).join('/') + '@' + targetRef : undefined;
            const mains = cs.regions.filter(r => r.phase === 'main' || target?.actionKind === 'save' && r.phase === 'save');
            const parsedHeaders = mains.map(r => ({ region: r, parsed: action ? inputHeader(ctx, sourceId, r, decodedLines, action) : null }));
            const parsedHeader = mains.length === 1 ? parsedHeaders[0]?.parsed : null;
            const header = parsedHeader && !('conflict' in parsedHeader) ? parsedHeader : null;
            const downloadPattern = profile.patterns.find(p => p.role === 'execution-commit')!;
            const downloaded: {
                commit: string;
                ref: SourceRef;
                declaration: SourceRef;
            }[] = [];
            for (const evidence of cs.evidence.filter(o => o.field === 'executedCommit')) {
                for (let ri = 0; ri < evidence.refs.length; ri++) {
                    const range = evidence.refs[ri]!;
                    if (range.sourceId !== sourceId)
                        continue;
                    if (css.some(s => s.regions.some(r => r.range.startLine <= range.endLine && range.startLine <= r.range.endLine)))
                        continue;
                    const declaration = evidence.refs[ri - 1]!;
                    if (!declaration.jsonPointer?.includes('/logRanges/'))
                        continue;
                    for (let line = range.startLine; line <= range.endLine; line++) {
                        const m = exact(downloadPattern, decodedLines[line - 1]!.text);
                        if (!m || m.action !== repositoryAction)
                            continue;
                        const ref = { sourceId, startLine: line, endLine: line };
                        downloaded.push({ commit: m.commit!, ref, declaration });
                        evidenceAnchor(ctx, ref);
                        const dl = decodedLines[line - 1]!, pref = prefix(downloadPattern, dl.text)!;
                        const begin = Array.from(dl.text.slice(0, pref.removed + "Download action repository '".length + m.action!.length + "' (SHA:".length)).length;
                        evidenceAnchor(ctx, ref, dl.columns[begin]!, dl.columns[begin + 39]! + 1);
                    }
                }
            }
            const shaValues = new Set(downloaded.map(d => d.commit));
            if (shaValues.size > 1)
                parsed.diagnostics.push(diagnostic('EXECUTION_COMMIT_CONFLICT', 'log', 'conflict', downloaded.map(d => d.ref)));
            const actualCommit = header && entry && shaValues.size === 1 && downloaded[0]?.commit === entry.sourceCommit ? downloaded[0] : undefined;
            for (const region of cs.regions) {
                const wf = matches.length === 1 ? matches[0] : undefined;
                const declaredRef = cs.evidence.find(o => o.field === 'actionRef' && o.value.state === 'value');
                const declaredCommit = cs.evidence.find(o => o.field === 'executedCommit' && o.value.state === 'value');
                const actionKind = wf ? { state: 'value' as const, value: wf.actionKind } : { state: 'missing' as const };
                const actionRef = declaredRef?.value ?? wf?.actionRef ?? { state: 'missing' as const };
                const entries = wf ? profile.entries.filter(e => e.actionKind === wf.actionKind && wf.actionRef.state === 'value' && e.declaredRefs.includes(wf.actionRef.value)) : [];
                const verification = actualCommit ? 'verified' as const : declaredCommit && entries.some(e => declaredCommit.value.state === 'value' && e.sourceCommit === declaredCommit.value.value) ? 'user_declared' as const : 'unverified' as const;
                const block: LogBlock = { id: `${sourceId}/b${region.range.startLine}:${region.phase}:${parsed.blocks.length}`, runId, range: region.range, phase: region.phase, actionKind, actionRef: actionRef as Presence<any>, jobId: wf?.jobId ?? ('jobId' in cs.target ? { state: 'value', value: cs.target.jobId } : { state: 'missing' }), stepId: wf?.stepId ?? ('stepId' in cs.target ? { state: 'value', value: cs.target.stepId } : { state: 'missing' }), stepIndex: wf ? { state: 'value', value: wf.stepIndex } : 'stepIndex' in cs.target ? { state: 'value', value: cs.target.stepIndex } : { state: 'missing' }, parentCandidates: [], completeness: { ...region.completeness, refs: [...region.completeness.refs] }, observationIds: [], profileEntryIds: entries.map(e => e.id), verification };
                byRegion.set(region.id, block);
                parsed.blocks.push(block);
                const contradiction = parsedHeaders.find(h => h.region.id === region.id)?.parsed;
                if (contradiction && 'conflict' in contradiction && wf) {
                    const workflowRef = registeredWorkflowActionRef(ctx, wf.stepRef);
                    if (!workflowRef)
                        throw new SafeFailure('SOURCE_REF_INVALID');
                    block.completeness.state = 'conflict';
                    parsed.diagnostics.push(diagnostic('ACTION_REF_CONFLICT', 'log', 'conflict', [workflowRef, contradiction.ref]));
                }
                if ((region.phase === 'main' || wf?.actionKind === 'save' && region.phase === 'save') && wf)
                    for (const d of [...new Map(downloaded.map(d => [JSON.stringify(d.ref), d])).values()]) {
                        const refs = [d.ref, d.declaration, ...(header?.refs ?? [])];
                        const o: Observation = { id: id('observation', [sourceId, block.id, downloadPattern.id, d.ref]), runId, stepRef: wf.stepRef, blockId: block.id, field: 'executedCommit', value: ctx.sanitizeField('executedCommit', d.commit, refs), status: shaValues.size > 1 ? 'conflict' : actualCommit ? 'confirmed' : 'unknown', refs, origin: 'log', patternId: downloadPattern.id, verification: actualCommit ? 'verified' : 'unverified' };
                        parsed.observations.push(o);
                        block.observationIds.push(o.id);
                    }
                if (declaredRef && wf?.actionRef.state === 'value' && declaredRef.value.state === 'value' && wf.actionRef.value !== declaredRef.value.value) {
                    block.completeness.state = 'conflict';
                    parsed.diagnostics.push(diagnostic('ACTION_REF_CONFLICT', 'log', 'conflict', declaredRef.refs));
                }
                for (const o of cs.evidence) {
                    const applies = region.phase === 'main' && !['saveOutcome', 'saveReason'].includes(o.field) || region.phase !== 'main' && ['saveOutcome', 'saveReason'].includes(o.field);
                    if (!applies)
                        continue;
                    const copy = { ...o, id: id('observation', [o.id, block.id]), refs: [...o.refs], blockId: block.id, ...(wf ? { stepRef: wf.stepRef } : {}) } as Observation;
                    parsed.observations.push(copy);
                    block.observationIds.push(copy.id);
                }
                for (let line = region.range.startLine; line <= region.range.endLine; line++) {
                    const ansi = decodedLines[line - 1]!;
                    const patterns = profile.patterns.filter(p => p.role === 'observation' && entries.some(e => e.patternIds.includes(p.id)) && (p.phase === region.phase || p.phase === 'save' && region.phase === 'post' || p.phase === 'post' && region.phase === 'save'));
                    const found: {
                        p: LogPattern;
                        captures: Record<string, string>;
                        values: Record<string, unknown>;
                        removed: number;
                    }[] = [];
                    for (const p of patterns) {
                        const pref = prefix(p, ansi.text);
                        if (!pref)
                            continue;
                        const m = match(p, pref.line);
                        if (m.length > 1) {
                            parsed.diagnostics.push(diagnostic('PATTERN_AMBIGUOUS', 'log', 'unverified', [{ sourceId, startLine: line, endLine: line }]));
                            continue;
                        }
                        if (!m.length)
                            continue;
                        const values = decode(p, m[0]!);
                        if (!values) {
                            parsed.diagnostics.push(diagnostic('PATTERN_CODEC_INVALID', 'log', 'unverified', [{ sourceId, startLine: line, endLine: line }]));
                            continue;
                        }
                        found.push({ p, captures: m[0]!, values, removed: pref.removed });
                    }
                    for (const f of found) {
                        const ref = { sourceId, startLine: line, endLine: line };
                        let ordinal = 0;
                        for (const output of f.p.outputs) {
                            if (!fields.includes(output.field as Field))
                                continue;
                            let val: unknown;
                            let refs: SourceRef[] = [ref];
                            if (output.from.kind === 'capture')
                                val = f.values[output.from.name];
                            else if (output.from.kind === 'constant')
                                val = output.from.value;
                            else {
                                if (output.field !== 'lockfileError' || !output.from.components)
                                    throw new SafeFailure('PROFILE_DECODER_UNSUPPORTED');
                                const component = output.from.components[0]!;
                                if (!actualCommit || !header || header.path.state !== 'value' || !component.patternIds.includes(header.patternId) || region.phase !== 'main' || line <= header.endLine) {
                                    parsed.diagnostics.push(diagnostic('LOCKFILE_COMPONENT_UNVERIFIED', 'log', 'unverified', [ref]));
                                    continue;
                                }
                                val = { path: header.path.state === 'value' ? header.path.value : '', reason: 'not-resolved', pathBasis: 'action-input' };
                                refs = [ref, ...header.refs, actualCommit.ref, actualCommit.declaration];
                            }
                            const field = output.field as Field;
                            const value = ctx.sanitizeField(field, val, refs);
                            const o = { id: id('observation', [sourceId, ref, f.p.id, field, ordinal++, block.id]), runId, ...(wf ? { stepRef: wf.stepRef } : {}), blockId: block.id, field, value, status: found.length > 1 ? 'conflict' : value.state === 'masked' ? 'unknown' : verification === 'verified' ? 'confirmed' : 'candidate', refs, origin: 'log', patternId: f.p.id, verification } as Observation;
                            parsed.observations.push(o);
                            block.observationIds.push(o.id);
                        }
                        // Only the captured field token enters a fragment; constants use a minimal literal anchor.
                        let produced = false;
                        for (const [name, capture] of Object.entries(f.captures)) {
                            const plain = prefix(f.p, ansi.text)!.line;
                            const position = f.p.segments.slice(0, f.p.segments.findIndex(s => 'capture' in s && s.capture === name)).reduce((n, s) => n + ('literal' in s ? s.literal.length : f.captures[s.capture]!.length), 0) + f.removed;
                            const before = Array.from(ansi.text.slice(0, position)).length, count = Array.from(capture).length;
                            const start = ansi.columns[before] ?? 0, end = count ? ((ansi.columns[before + count - 1] ?? start) + 1) : start;
                            const r = ctx.requestExcerpt(ref, [{ line, startColumn: start, endColumn: end }]);
                            if (!r.ok)
                                throw new SafeFailure(r.diagnostics[0]!.code, r.diagnostics[0]!.category);
                            produced = true;
                        }
                        if (!produced) {
                            const r = ctx.requestExcerpt(ref, [{ line, startColumn: 0, endColumn: 0 }]);
                            if (!r.ok)
                                throw new SafeFailure(r.diagnostics[0]!.code);
                        }
                    }
                    if (!found.length && /^(?:Cache |::debug::primary key|Some specified paths)/.test(ansi.text)) {
                        const ref = { sourceId, startLine: line, endLine: line };
                        parsed.diagnostics.push(diagnostic('LOG_PATTERN_UNVERIFIED', 'log', 'unverified', [ref]));
                        const anchor = ctx.requestExcerpt(ref, [{ line, startColumn: 0, endColumn: 0 }]);
                        if (!anchor.ok)
                            throw new SafeFailure(anchor.diagnostics[0]!.code, anchor.diagnostics[0]!.category);
                    }
                }
                if (region.phase === 'main' && !parsed.observations.some(o => o.blockId === block.id && o.field === 'cacheHit')) {
                    const ref = region.declarationRef;
                    const o: Observation = { id: id('observation', [block.id, 'cacheHit', 'unrecorded']), runId, ...(wf ? { stepRef: wf.stepRef } : {}), blockId: block.id, field: 'cacheHit', value: { state: 'value', value: 'unrecorded' }, status: 'unknown', refs: [ref], origin: 'log', verification: 'unverified' };
                    parsed.observations.push(o);
                    block.observationIds.push(o.id);
                }
                check(parsed.observations.length, LIMITS.observations, 'OBSERVATION_LIMIT');
            }
        }
        for (const cs of css)
            for (const region of cs.regions) {
                const block = byRegion.get(region.id)!;
                if (region.parentRegionId) {
                    const p = byRegion.get(region.parentRegionId);
                    if (p)
                        block.parentCandidates = [p.id];
                }
            }
        parsed.diagnostics = [...new Map(parsed.diagnostics.map(d => [d.id, d])).values()];
        markConflicts(parsed.observations);
        parsed.observations.sort((a, b) => {
            const sourceOrder = (o: Observation) => o.refs[0]!.sourceId === sourceId ? 0 : 1;
            const step = (o: Observation) => workflow.steps.find(s => s.stepRef === o.stepRef);
            const sa = step(a), sb = step(b);
            return sourceOrder(a) - sourceOrder(b) || (sa?.jobIndex ?? Number.MAX_SAFE_INTEGER) - (sb?.jobIndex ?? Number.MAX_SAFE_INTEGER) || (sa?.stepIndex ?? Number.MAX_SAFE_INTEGER) - (sb?.stepIndex ?? Number.MAX_SAFE_INTEGER) || a.refs[0]!.startLine - b.refs[0]!.startLine || fields.indexOf(a.field) - fields.indexOf(b.field) || a.id.localeCompare(b.id);
        });
        return parsed;
    });
}

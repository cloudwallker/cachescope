import { parseDocument, isMap, isSeq, isScalar, isAlias } from 'yaml';
import type { Node } from 'yaml';
import type { ParsedWorkflow, Result, Id, ActionKind, SourceRef, WorkflowInput, InputName, Presence, Text } from './model.ts';
import { validateParseContext, chargeExpandedNodes, sanitizeSourceText, recordWorkflowActionRef, requestWorkflowAnchors } from './input.ts';
import type { ParseContext } from './input.ts';
import { LIMITS, check, SafeFailure, ok, lineAt, safeString, diagnostic, staticText } from './safety.ts';
const inputs: InputName[] = ['key', 'restore-keys', 'path', 'cache', 'cache-dependency-path', 'enableCrossOsArchive', 'lookup-only', 'fail-on-cache-miss', 'package-manager-cache'];
const actions: Record<string, ActionKind> = { 'actions/cache': 'cache', 'actions/cache/restore': 'restore', 'actions/cache/save': 'save', 'actions/setup-node': 'setup-node' };
export function parseWorkflow(ctx: ParseContext, sourceId: Id): Result<ParsedWorkflow> {
    const guard = validateParseContext(ctx, sourceId, 'workflow');
    if (!guard.ok)
        return guard;
    return ctx.withSource(sourceId, (text, offsets) => {
        // Lone CR is a physical newline too; substitution preserves every UTF-16 offset.
        const doc = parseDocument(text.replace(/\r(?!\n)/g, '\n'), { uniqueKeys: true, strict: true, prettyErrors: false, keepSourceTokens: true });
        if (doc.errors.length)
            throw new SafeFailure('YAML_INVALID');
        let nodes = 0, aliases = 0;
        const active = new Set<unknown>();
        const physicalAliases = (node: unknown, depth = 1): void => {
            if (isAlias(node)) {
                check(++aliases, LIMITS.aliases, 'ALIAS_LIMIT');
                return;
            }
            if (isMap(node) || isSeq(node))
                check(depth, LIMITS.depth, 'DEPTH_LIMIT');
            if (isMap(node))
                for (const p of node.items) {
                    physicalAliases(p.key, depth + 1);
                    physicalAliases(p.value, depth + 1);
                }
            else if (isSeq(node))
                for (const v of node.items)
                    physicalAliases(v, depth + 1);
        };
        physicalAliases(doc.contents);
        const scan = (node: unknown, depth: number): void => {
            if (node === null)
                return;
            check(++nodes, LIMITS.nodes, 'NODE_LIMIT');
            if (isAlias(node)) {
                const dest = node.resolve(doc);
                if (!dest)
                    throw new SafeFailure('ALIAS_INVALID');
                if (active.has(dest))
                    throw new SafeFailure('ALIAS_CYCLE');
                scan(dest, depth);
                return;
            }
            if (isMap(node) || isSeq(node)) {
                check(depth, LIMITS.depth, 'DEPTH_LIMIT');
                if (active.has(node))
                    throw new SafeFailure('ALIAS_CYCLE');
                active.add(node);
                for (const v of node.items) {
                    if (isMap(node)) {
                        const pair = v as any;
                        scan(pair.key, depth + 1);
                        scan(pair.value, depth + 1);
                    }
                    else
                        scan(v, depth + 1);
                }
                active.delete(node);
            }
        };
        scan(doc.contents, 1);
        chargeExpandedNodes(ctx, nodes);
        const deref = (n: unknown): any => isAlias(n) ? deref(n.resolve(doc)) : n;
        const get = (n: unknown, key: string): any => {
            n = deref(n);
            if (!isMap(n))
                return undefined;
            return n.items.find(p => isScalar(p.key) && p.key.value === key)?.value;
        };
        const range = (n: any): SourceRef => {
            const r = n?.range;
            if (!r)
                throw new SafeFailure('YAML_RANGE_INVALID');
            return { sourceId, startLine: lineAt(offsets.starts, r[0]), endLine: lineAt(offsets.starts, Math.max(r[0], r[1] - 1)) };
        };
        const scalar = (n: any): string | undefined => { n = deref(n); return isScalar(n) && ['string', 'number', 'boolean'].includes(typeof n.value) ? String(n.value) : undefined; };
        const cleanScalar = (n: any, value: string, semantic?: string) => sanitizeSourceText(ctx, value, range(n), { start: n.range[0], end: n.range[1] }, semantic);
        const request = (n: any, ref: SourceRef): void => {
            const r = n.range;
            if (!r)
                return;
            for (let line = ref.startLine; line <= ref.endLine; line++) {
                const start = Math.max(r[0], offsets.starts[line - 1]!) - offsets.starts[line - 1]!;
                const end = Math.min(r[1], offsets.ends[line - 1]!) - offsets.starts[line - 1]!;
                const cps = Array.from(offsets.lines[line - 1]!);
                let a = Array.from(offsets.lines[line - 1]!.slice(0, start)).length;
                const b = Array.from(offsets.lines[line - 1]!.slice(0, end)).length;
                while (a < b) {
                    let c = a, size = 0;
                    while (c < b && size + Buffer.byteLength(cps[c]!) <= LIMITS.excerptSize) {
                        size += Buffer.byteLength(cps[c]!);
                        c++;
                    }
                    const part = ctx.requestExcerpt(ref, [{ line, startColumn: a, endColumn: c }]);
                    if (!part.ok)
                        throw new SafeFailure(part.diagnostics[0]!.code, part.diagnostics[0]!.category);
                    a = c;
                }
            }
        };
        const safe = (n: any, semantic?: string): Presence<Text> => {
            if (n === undefined)
                return { state: 'missing' };
            const value = scalar(n);
            if (value === undefined)
                throw new SafeFailure('WORKFLOW_INPUT_SCHEMA');
            return cleanScalar(n, value, semantic);
        };
        const installTokens = (run: any): {
            command: string;
            ref: SourceRef;
            part: {
                line: number;
                startColumn: number;
                endColumn: number;
            };
        }[] => {
            if (isAlias(run) || !isScalar(run) || typeof run.value !== 'string' || !run.range)
                return [];
            const r = run.range, ref = range(run), matches: {
                command: string;
                ref: SourceRef;
                part: {
                    line: number;
                    startColumn: number;
                    endColumn: number;
                };
            }[] = [];
            const add = (line: number, content: string, base: number) => {
                const m = /^\s*(npm (?:ci|install)|yarn install|pnpm install)\s*$/.exec(content);
                if (!m)
                    return;
                const at = base + content.indexOf(m[1]!);
                const startColumn = Array.from(offsets.lines[line - 1]!.slice(0, at)).length;
                matches.push({ command: m[1]!, ref: { sourceId, startLine: line, endLine: line }, part: { line, startColumn, endColumn: startColumn + Array.from(m[1]!).length } });
            };
            if (run.type === 'BLOCK_LITERAL') {
                for (let line = ref.startLine + 1; line <= ref.endLine; line++)
                    add(line, offsets.lines[line - 1]!, 0);
            }
            else if (ref.startLine === ref.endLine && run.type !== 'BLOCK_FOLDED') {
                const raw = text.slice(r[0], r[1]), decoded = run.value;
                if (raw === decoded)
                    add(ref.startLine, raw, r[0] - offsets.starts[ref.startLine - 1]!);
                else if (raw === '"' + decoded + '"' || raw === "'" + decoded + "'")
                    add(ref.startLine, decoded, r[0] - offsets.starts[ref.startLine - 1]! + 1);
            }
            return matches;
        };
        const jobs = deref(get(doc.contents, 'jobs'));
        if (!isMap(jobs))
            throw new SafeFailure('WORKFLOW_JOBS_INVALID');
        const output: ParsedWorkflow = { sourceId, steps: [], installSteps: [], diagnostics: [] };
        let totalSteps = 0;
        jobs.items.forEach((job, jobIndex) => {
            const seq = deref(get(job.value, 'steps'));
            if (seq === undefined)
                return;
            if (!isSeq(seq))
                throw new SafeFailure('WORKFLOW_STEPS_INVALID');
            check(totalSteps += seq.items.length, LIMITS.steps, 'WORKFLOW_STEPS_LIMIT');
            seq.items.forEach((item, stepIndex) => {
                const entry = deref(item);
                if (!isMap(entry))
                    throw new SafeFailure('WORKFLOW_STEP_INVALID');
                const stepRef = `${sourceId}/j${jobIndex}/s${stepIndex}`;
                const uses = get(entry, 'uses');
                const action = scalar(uses);
                const run = get(entry, 'run');
                if (run !== undefined) {
                    const tokens = installTokens(run);
                    for (const token of tokens) {
                        output.installSteps.push({ stepRef, jobIndex, stepIndex, range: token.ref, packageManager: token.command.split(' ')[0] as 'npm' | 'yarn' | 'pnpm', evidence: 'static-command' });
                        const part = ctx.requestExcerpt(token.ref, [token.part]);
                        if (!part.ok)
                            throw new SafeFailure(part.diagnostics[0]!.code, part.diagnostics[0]!.category);
                    }
                }
                if (action === undefined)
                    return;
                const at = action.lastIndexOf('@');
                if (at <= 0)
                    return;
                const name = action.slice(0, at).toLowerCase(), kind = actions[name];
                if (!kind)
                    return;
                const actionNodes: any[] = [];
                if (isAlias(item))
                    actionNodes.push(item);
                let node = uses;
                while (isAlias(node)) {
                    actionNodes.push(node);
                    node = node.resolve(doc);
                }
                actionNodes.push(node);
                // Sanitize both declaration and alias usage before any excerpt is produced.
                let actionRef = cleanScalar(node, action.slice(at + 1));
                for (const n of actionNodes)
                    if (cleanScalar(n, action.slice(at + 1)).state === 'masked')
                        actionRef = { state: 'masked' };
                const actionRefRefs = [...new Map(actionNodes.map(n => [JSON.stringify(range(n)), range(n)])).values()];
                const step = { stepRef, jobIndex, jobId: safe(job.key), stepIndex, stepId: safe(get(entry, 'id')), range: range(item), actionKind: kind, actionRef, actionRefRefs, inputs: [] as WorkflowInput[] };
                recordWorkflowActionRef(ctx, stepRef, range(uses));
                for (const n of actionNodes)
                    request(n, range(n));
                const withMap = deref(get(entry, 'with'));
                if (withMap !== undefined && !isMap(withMap))
                    throw new SafeFailure('WORKFLOW_WITH_INVALID');
                if (get(withMap, 'resolvedKey') !== undefined)
                    throw new SafeFailure('UNKNOWN_FIELD_ALIAS');
                for (const name of inputs) {
                    const n = get(withMap, name);
                    if (n === undefined)
                        continue;
                    const value = scalar(n);
                    if (value === undefined)
                        throw new SafeFailure('WORKFLOW_INPUT_SCHEMA');
                    if (name === 'key')
                        check(Array.from(value).length, LIMITS.key, 'KEY_LIMIT');
                    if (name === 'restore-keys')
                        value.split(/\r\n|\r|\n/).forEach(k => check(Array.from(k).length, LIMITS.key, 'KEY_LIMIT'));
                    const ref = range(n);
                    const expressions = [...value.matchAll(/\$\{\{[\s\S]*?\}\}/g)];
                    expressions.forEach(e => check(Buffer.byteLength(e[0]), LIMITS.expression, 'EXPRESSION_LIMIT'));
                    const clean = cleanScalar(n, value, name);
                    const wi: WorkflowInput = { name, value: clean, form: expressions.length === 0 ? 'literal' : expressions.length === 1 && expressions[0]![0] === value ? 'expression' : 'mixed', refs: [ref], expressions: expressions.map(e => ({ text: clean.state === 'masked' ? { state: 'masked' } : safeString(e[0]), refs: [ref] })) };
                    request(n, ref);
                    step.inputs.push(wi);
                }
                if (actionRef.state !== 'value')
                    output.diagnostics.push(diagnostic('ACTION_REF_UNKNOWN', 'workflow', 'unverified', actionRefRefs));
                requestWorkflowAnchors(ctx, step.range, { start: (item as any).range[0], end: (item as any).range[1] });
                output.steps.push(step);
            });
        });
        output.diagnostics = [...new Map(output.diagnostics.map(d => [d.id, d])).values()];
        return output;
    });
}

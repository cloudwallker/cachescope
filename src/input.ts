import { randomUUID } from 'node:crypto';
import { open, realpath, lstat, stat, unlink } from 'node:fs/promises';
import { resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import type { BigIntStats } from 'node:fs';
import type { AnalysisInputs, Source, SourceKind, Id, Result, Presence, Field, FieldValues, Text, SourceRef, EvidenceExcerpt, Context, ContextStep, ContextRegion, StepTarget, ParsedWorkflow, RunId, Observation, Pagination, ListScope, Diagnostic } from './model.ts';
import { parseWorkflow } from './workflow.ts';
import { parseRunLog } from './logs.ts';
import { parseCacheList } from './cache-list.ts';
import { profile } from './profile.ts';
import { LIMITS, hash, id, ok, fail, diagnostic, SafeFailure, check, physical, lineAt, sanitize, safeString, staticText, object, integer, fields, parseJson, freeze, isSecret } from './safety.ts';
export interface InputPaths {
    workflow: string;
    runA: string;
    runB: string;
    context?: string;
    cacheList?: string;
}
export interface FileIdentity {
    device: string;
    fileId: string;
}
export interface InputIdentity {
    slot: SourceKind | 'log-a' | 'log-b';
    canonicalAbsolutePath: string;
    realPath: string;
    file: FileIdentity;
    size: number;
    mtimeNs: string;
    ctimeNs: string;
    sha256: string;
}
const guardBrand: unique symbol = Symbol('input');
const permitBrand: unique symbol = Symbol('output');
const parseBrand: unique symbol = Symbol('parse');
export interface InputGuard {
    readonly [guardBrand]: true;
    toJSON(): never;
}
export interface OutputPermit {
    readonly [permitBrand]: true;
    toJSON(): never;
}
export interface LoadedInputs {
    inputs: AnalysisInputs;
    guard: InputGuard;
}
export interface OutputRequest {
    kind: 'html' | 'json';
    path: string;
}
export interface OutputPayload {
    kind: 'html' | 'json';
    utf8: Uint8Array;
}
export interface OutputPlan {
    entries: {
        kind: 'html' | 'json';
        canonicalPath: string;
        parentRealPath: string;
        parentIdentity: FileIdentity;
        existing?: FileIdentity;
        mode: 'exclusive-create' | 'atomic-replace';
    }[];
    permit: OutputPermit;
}
interface OffsetTable {
    starts: number[];
    ends: number[];
    lines: string[];
}
export interface ParseContext {
    readonly [parseBrand]: true;
    toJSON(): never;
    guard(sourceId: Id, kind: SourceKind): Result<null>;
    withSource<T>(sourceId: Id, callback: (text: string, offsets: OffsetTable) => T): Result<T>;
    sanitizeField<F extends Field>(field: F, value: unknown, refs: SourceRef[]): Presence<FieldValues[F]>;
    requestExcerpt(ref: SourceRef, parts: {
        line: number;
        startColumn: number;
        endColumn: number;
    }[]): Result<Id>;
}
interface RawSource {
    source: Source;
    text: string;
    offsets: OffsetTable;
    blocked: Set<number>;
    maskedParts?: Map<number, {
        startColumn: number;
        endColumn: number;
    }[]>;
    jsonNodes?: Map<string, {
        start: number;
        end: number;
    }>;
}
interface Session {
    raw: Map<Id, RawSource>;
    excerpts: EvidenceExcerpt[];
    bytes: number;
    nodes: number;
    active: boolean;
    workflow?: ParsedWorkflow;
    actionRefs?: Map<Id, SourceRef>;
}
interface PermitData {
    guard: InputGuard;
    requests: OutputRequest[];
    plan: OutputPlan;
    overwrite: boolean;
    root?: string;
}
const guardInputs = new WeakMap<InputGuard, AnalysisInputs>();
const sessions = new WeakMap<ParseContext, Session>();
const guards = new WeakMap<InputGuard, InputIdentity[]>();
const permits = new WeakMap<OutputPermit, PermitData>();
const trusted = new WeakSet<AnalysisInputs>();
const privateJSON = (): never => { throw new Error('PRIVATE_CAPABILITY'); };
const fileId = (s: BigIntStats): FileIdentity => ({ device: String(s.dev), fileId: String(s.ino) });
const sameFile = (a: FileIdentity, b: FileIdentity) => a.device === b.device && a.fileId === b.fileId && a.fileId !== '0';
const norm = (s: string) => process.platform === 'win32' ? resolve(s).toLowerCase() : resolve(s);
const sameStat = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function errorResult<T>(e: unknown, stage: Diagnostic['stage'] = 'input'): Result<T> { return e instanceof SafeFailure ? fail(e.code, stage, e.category) : fail('IO_FAILURE', stage, 'io'); }
function session(ctx: ParseContext): Session {
    const s = sessions.get(ctx);
    if (!s?.active)
        throw new SafeFailure('PARSE_CAPABILITY_INVALID');
    return s;
}
export function validateParseContext(ctx: ParseContext, sourceId: Id, kind: SourceKind): Result<null> {
    try {
        session(ctx);
        return ctx.guard(sourceId, kind);
    }
    catch (e) {
        return errorResult(e);
    }
}
export function registeredWorkflow(ctx: ParseContext): ParsedWorkflow {
    const w = session(ctx).workflow;
    if (!w)
        throw new SafeFailure('WORKFLOW_NOT_REGISTERED');
    return w;
}
export function recordWorkflowActionRef(ctx: ParseContext, stepRef: Id, ref: SourceRef): void {
    const s = session(ctx);
    if (!validRef(s, ref) || s.raw.get(ref.sourceId)!.source.kind !== 'workflow')
        throw new SafeFailure('SOURCE_REF_INVALID');
    s.actionRefs ??= new Map();
    s.actionRefs.set(stepRef, ref);
}
export function registeredWorkflowActionRef(ctx: ParseContext, stepRef: Id): SourceRef | undefined { return session(ctx).actionRefs?.get(stepRef); }
// Internal producer bridge: only opaque endpoints, never a raw source getter.
export function requestWorkflowAnchors(ctx: ParseContext, ref: SourceRef, bounds: {
    start: number;
    end: number;
}): void {
    const s = session(ctx);
    if (!validRef(s, ref) || s.raw.get(ref.sourceId)!.source.kind !== 'workflow')
        throw new SafeFailure('SOURCE_REF_INVALID');
    requestStructureAnchors(ctx, ref, bounds);
}
function requestStructureAnchors(ctx: ParseContext, ref: SourceRef, bounds: {
    start: number;
    end: number;
}): void {
    const s = session(ctx);
    if (!validRef(s, ref))
        throw new SafeFailure('SOURCE_REF_INVALID');
    const raw = s.raw.get(ref.sourceId)!;
    for (const line of new Set([ref.startLine, ref.endLine])) {
        if (s.excerpts.some(e => e.ref.sourceId === ref.sourceId && e.lines.some(l => l.line === line)))
            continue;
        const offset = line === ref.startLine ? bounds.start : Math.max(bounds.start, bounds.end - 1);
        const at = Math.max(raw.offsets.starts[line - 1]!, Math.min(offset, raw.offsets.ends[line - 1]!));
        const column = Array.from(raw.offsets.lines[line - 1]!.slice(0, at - raw.offsets.starts[line - 1]!)).length;
        const r = ctx.requestExcerpt(ref.jsonPointer === undefined ? { sourceId: ref.sourceId, startLine: line, endLine: line } : ref, [{ line, startColumn: column, endColumn: column }]);
        if (!r.ok)
            throw new SafeFailure(r.diagnostics[0]!.code, r.diagnostics[0]!.category);
    }
}
function requestJsonStructureAnchors(ctx: ParseContext, inputs: AnalysisInputs): void {
    const s = session(ctx), seen = new Set<object>();
    const walk = (value: unknown): void => {
        if (!value || typeof value !== 'object' || seen.has(value))
            return;
        seen.add(value);
        if ('sourceId' in value && 'startLine' in value && 'jsonPointer' in value) {
            const ref = value as SourceRef;
            if (!validRef(s, ref))
                throw new SafeFailure('SOURCE_REF_INVALID');
            const raw = s.raw.get(ref.sourceId)!, node = raw.jsonNodes?.get(ref.jsonPointer!);
            if (node && (raw.text[node.start] === '{' || raw.text[node.start] === '['))
                requestStructureAnchors(ctx, ref, node);
        }
        for (const child of Object.values(value))
            walk(child);
    };
    // Existing safe DTO references only; never scan arbitrary JSON nodes for output.
    walk({ ...inputs, excerpts: [], profile: null });
}
export function chargeExpandedNodes(ctx: ParseContext, n: number): void { const s = session(ctx); check(s.nodes + n, LIMITS.nodes, 'NODE_LIMIT'); s.nodes += n; }
function validRef(s: Session, ref: SourceRef): boolean {
    const raw = s.raw.get(ref.sourceId);
    if (!raw || !integer(ref.startLine) || ref.startLine < 1 || !integer(ref.endLine) || ref.endLine < ref.startLine || ref.endLine > raw.source.lineCount)
        return false;
    if (ref.jsonPointer !== undefined) {
        if (!['context', 'cache-list'].includes(raw.source.kind))
            return false;
        const n = raw.jsonNodes?.get(ref.jsonPointer);
        if (!n)
            return false;
        return lineAt(raw.offsets.starts, n.start) === ref.startLine && lineAt(raw.offsets.starts, Math.max(n.start, n.end - 1)) === ref.endLine;
    }
    return true;
}
function isMaskedPart(raw: RawSource, line: number, start: number, end: number): boolean {
    return raw.maskedParts?.get(line)?.some(p => p.startColumn < end && start < p.endColumn) ?? false;
}
function maskRef(s: Session, ref: SourceRef, offsetRange?: {
    start: number;
    end: number;
}): void {
    if (!validRef(s, ref))
        throw new SafeFailure('SOURCE_REF_INVALID');
    const raw = s.raw.get(ref.sourceId)!;
    const node = ref.jsonPointer === undefined ? undefined : raw.jsonNodes!.get(ref.jsonPointer)!;
    const bounds = offsetRange ?? node ?? { start: raw.offsets.starts[ref.startLine - 1]!, end: raw.offsets.ends[ref.endLine - 1]! };
    if (!integer(bounds.start) || !integer(bounds.end) || bounds.end < bounds.start || bounds.start < raw.offsets.starts[ref.startLine - 1]! || bounds.end > (raw.offsets.starts[ref.endLine] ?? raw.text.length))
        throw new SafeFailure('EXCERPT_RANGE_INVALID');
    raw.maskedParts ??= new Map();
    for (let line = ref.startLine; line <= ref.endLine; line++) {
        const base = raw.offsets.starts[line - 1]!, text = raw.offsets.lines[line - 1]!;
        const start = Math.max(bounds.start, base) - base, end = Math.min(bounds.end, raw.offsets.ends[line - 1]!) - base;
        if (end <= start)
            continue;
        const part = { startColumn: Array.from(text.slice(0, start)).length, endColumn: Array.from(text.slice(0, end)).length };
        const list = raw.maskedParts.get(line) ?? [];
        list.push(part);
        raw.maskedParts.set(line, list);
    }
    // Earlier token requests can precede field decoding; replace their representation too.
    for (const excerpt of s.excerpts.filter(e => e.ref.sourceId === ref.sourceId)) {
        const oldSize = excerpt.lines.reduce((n, l) => n + l.parts.reduce((n, p) => n + Buffer.byteLength(p.text), 0), 0);
        for (const line of excerpt.lines)
            for (const part of line.parts)
                if (isMaskedPart(raw, line.line, part.startColumn, part.endColumn)) {
                    part.text = staticText('[已遮盖]');
                    excerpt.redacted = true;
                }
        const size = excerpt.lines.reduce((n, l) => n + l.parts.reduce((n, p) => n + Buffer.byteLength(p.text), 0), 0);
        check(size, LIMITS.excerptSize, 'EXCERPT_SIZE_LIMIT');
        check(s.bytes - oldSize + size, LIMITS.excerptBytes, 'EXCERPT_BYTES_LIMIT');
        s.bytes += size - oldSize;
    }
}
// Internal scalar decoder bridge; the loader remains the only owner of mask positions.
export function sanitizeSourceText(ctx: ParseContext, value: string, ref: SourceRef, offsetRange?: {
    start: number;
    end: number;
}, semantic?: string): Presence<Text> {
    const s = session(ctx);
    if (!validRef(s, ref))
        throw new SafeFailure('SOURCE_REF_INVALID');
    const clean = safeString(value, semantic);
    if (clean.state === 'masked')
        maskRef(s, ref, offsetRange);
    return clean;
}
function createContext(s: Session): ParseContext {
    const ctx: ParseContext = { [parseBrand]: true, toJSON: privateJSON,
        guard(sourceId, kind) {
            try {
                const a = session(this);
                const src = a.raw.get(sourceId);
                if (!src || src.source.kind !== kind)
                    return fail('SOURCE_REGISTRATION_INVALID');
                return ok(null);
            }
            catch (e) {
                return errorResult(e);
            }
        },
        withSource<T>(sourceId: Id, callback: (text: string, offsets: OffsetTable) => T): Result<T> {
            try {
                const a = session(this), r = a.raw.get(sourceId);
                if (!r)
                    return fail('SOURCE_REGISTRATION_INVALID');
                const value = callback(r.text, r.offsets);
                validateSafeTree(value, a);
                return ok(value);
            }
            catch (e) {
                return errorResult(e);
            }
        },
        sanitizeField(field, value, refs) {
            const a = session(this);
            if (!refs.every(r => validRef(a, r)))
                throw new SafeFailure('SOURCE_REF_INVALID');
            const blocked = refs.some(r => {
                const raw = a.raw.get(r.sourceId)!;
                for (let n = r.startLine; n <= r.endLine; n++)
                    if (raw.blocked.has(n))
                        return true;
                return false;
            });
            const clean = blocked ? { state: 'masked' as const } : sanitize(field, value);
            if (clean.state === 'masked')
                for (const ref of refs)
                    maskRef(a, ref);
            return clean;
        },
        requestExcerpt(ref, parts) {
            try {
                const a = session(this);
                if (!validRef(a, ref))
                    return fail('SOURCE_REF_INVALID');
                const raw = a.raw.get(ref.sourceId)!;
                const lines: EvidenceExcerpt['lines'] = [];
                let redacted = false;
                for (const p of parts) {
                    if (!integer(p.line) || p.line < ref.startLine || p.line > ref.endLine || !integer(p.startColumn) || !integer(p.endColumn) || p.endColumn < p.startColumn)
                        return fail('EXCERPT_RANGE_INVALID');
                    const cps = Array.from(raw.offsets.lines[p.line - 1]!);
                    if (p.endColumn > cps.length)
                        return fail('EXCERPT_RANGE_INVALID');
                    const original = cps.slice(p.startColumn, p.endColumn).join('');
                    const clean = safeString(original);
                    const text = p.startColumn === p.endColumn || raw.blocked.has(p.line) || isMaskedPart(raw, p.line, p.startColumn, p.endColumn) || clean.state === 'masked' ? staticText('[已遮盖]') : clean.state === 'value' ? clean.value : staticText('');
                    if (text === '[已遮盖]')
                        redacted = true;
                    let l = lines.find(l => l.line === p.line);
                    if (!l) {
                        l = { line: p.line, parts: [] };
                        lines.push(l);
                    }
                    l.parts.push({ startColumn: p.startColumn, endColumn: p.endColumn, text });
                }
                lines.sort((a, b) => a.line - b.line);
                for (const l of lines)
                    l.parts.sort((a, b) => a.startColumn - b.startColumn);
                check(lines.length, LIMITS.excerptLines, 'EXCERPT_LINES_LIMIT');
                const size = lines.reduce((n, l) => n + l.parts.reduce((n, p) => n + Buffer.byteLength(p.text), 0), 0);
                check(size, LIMITS.excerptSize, 'EXCERPT_SIZE_LIMIT');
                const key = id('excerpt', [ref, lines.map(l => [l.line, l.parts.map(p => [p.startColumn, p.endColumn])])]);
                const exists = a.excerpts.find(e => e.id === key);
                if (exists)
                    return ok(key);
                check(a.excerpts.length + 1, LIMITS.excerpts, 'EXCERPT_COUNT_LIMIT');
                check(a.bytes + size, LIMITS.excerptBytes, 'EXCERPT_BYTES_LIMIT');
                a.bytes += size;
                a.excerpts.push({ id: key, ref, redacted, lines });
                return ok(key);
            }
            catch (e) {
                return errorResult(e);
            }
        }
    };
    sessions.set(ctx, s);
    return Object.freeze(ctx);
}
function validateSafeTree(value: unknown, s: Session): void {
    const seen = new Set<unknown>();
    const walk = (v: unknown, key = '') => {
        if (v === undefined)
            throw new SafeFailure('MODEL_UNDEFINED');
        if (typeof v === 'string') {
            if (!['sha256', 'id', 'sourceId', 'stepRef', 'blockId', 'patternId', 'sourceCommit', 'commit', 'contentSha256', 'executedCommit', 'url', 'jsonPointer'].includes(key) && isSecret(v))
                throw new SafeFailure('MODEL_UNSAFE_TEXT');
            return;
        }
        if (v === null || typeof v !== 'object')
            return;
        if (seen.has(v))
            return;
        seen.add(v);
        if (object(v) && typeof v.sourceId === 'string' && Object.hasOwn(v, 'startLine')) {
            if (!validRef(s, v as unknown as SourceRef))
                throw new SafeFailure('SOURCE_REF_INVALID');
        }
        for (const [k, x] of Object.entries(v))
            walk(x, k);
    };
    walk(value);
}
async function readBounded(path: string, slot: InputIdentity['slot'], kind: SourceKind): Promise<{
    identity: InputIdentity;
    text: string;
    source: Source;
}> {
    if (typeof path !== 'string' || !path || path === '-')
        throw new SafeFailure('INPUT_PATH_INVALID');
    const canonicalAbsolutePath = resolve(path);
    const real = await realpath(canonicalAbsolutePath);
    const handle = await open(canonicalAbsolutePath, 'r');
    try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile())
            throw new SafeFailure('INPUT_NOT_FILE');
        check(Number(before.size), LIMITS[kind], 'INPUT_BYTES_LIMIT');
        const chunks: Buffer[] = [];
        let size = 0;
        for (;;) {
            const buffer = Buffer.alloc(65536);
            const r = await handle.read(buffer, 0, buffer.length, null);
            if (!r.bytesRead)
                break;
            size += r.bytesRead;
            check(size, LIMITS[kind], 'INPUT_BYTES_LIMIT');
            chunks.push(buffer.subarray(0, r.bytesRead));
        }
        const after = await handle.stat({ bigint: true });
        if (!sameStat(before, after) || size !== Number(before.size))
            throw new SafeFailure('INPUT_CHANGED', 'io');
        const bytes = Buffer.concat(chunks);
        let text: string;
        try {
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        }
        catch {
            throw new SafeFailure('UTF8_INVALID');
        }
        if (text.includes('\0'))
            throw new SafeFailure('NUL_INVALID');
        const sha256 = hash(bytes);
        const label = slot === 'log-a' ? 'run-a' : slot === 'log-b' ? 'run-b' : slot;
        const source = { id: `src:${slot}:${sha256}`, kind, label: staticText(label), sha256, lineCount: physical(text).lines.length };
        const now = await stat(canonicalAbsolutePath, { bigint: true });
        if (!sameStat(after, now) || await realpath(canonicalAbsolutePath) !== real)
            throw new SafeFailure('INPUT_CHANGED', 'io');
        const identity: InputIdentity = { slot, canonicalAbsolutePath, realPath: real, file: fileId(before), size, mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs), sha256 };
        Object.defineProperty(identity, 'toJSON', { value: privateJSON, enumerable: false });
        return { text, source, identity: freeze(identity) };
    }
    finally {
        await handle.close();
    }
}
export async function loadAnalysisInputs(paths: InputPaths): Promise<Result<LoadedInputs>> {
    let s: Session | undefined;
    try {
        if (!object(paths) || Object.keys(paths).some(k => !['workflow', 'runA', 'runB', 'context', 'cacheList'].includes(k)))
            return fail('INPUT_PATHS_INVALID');
        const specs: [
            InputIdentity['slot'],
            SourceKind,
            string
        ][] = [['workflow', 'workflow', paths.workflow], ['log-a', 'log', paths.runA], ['log-b', 'log', paths.runB]];
        if (paths.context !== undefined)
            specs.push(['context', 'context', paths.context]);
        if (paths.cacheList !== undefined)
            specs.push(['cache-list', 'cache-list', paths.cacheList]);
        const reads = [];
        let lines = 0, nodes = 0;
        for (const [slot, kind, path] of specs) {
            const r = await readBounded(path, slot, kind);
            lines += r.source.lineCount;
            check(lines, LIMITS.lines, 'TOTAL_LINES_LIMIT');
            if (kind === 'context' || kind === 'cache-list')
                parseJson(r.text, n => { nodes += n; check(nodes, LIMITS.nodes, 'NODE_LIMIT'); });
            reads.push(r);
        }
        s = { raw: new Map(), excerpts: [], bytes: 0, nodes, active: true };
        for (const r of reads) {
            const offsets = physical(r.text), blocked = new Set<number>();
            let pem = false;
            offsets.lines.forEach((line, i) => {
                if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line))
                    pem = true;
                if (pem)
                    blocked.add(i + 1);
                if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line))
                    pem = false;
            });
            if (s.raw.has(r.source.id))
                throw new SafeFailure('DUPLICATE_ID');
            s.raw.set(r.source.id, { source: r.source, text: r.text, offsets, blocked, ...(r.source.kind === 'context' || r.source.kind === 'cache-list' ? { jsonNodes: parseJson(r.text, () => { }).nodes } : {}) });
        }
        const ctx = createContext(s), wf = parseWorkflow(ctx, reads[0]!.source.id);
        if (!wf.ok)
            return wf;
        s.workflow = wf.value;
        let context: Context | undefined;
        if (paths.context !== undefined) {
            const r = parseContext(ctx, reads.find(r => r.source.kind === 'context')!.source.id, wf.value, { a: reads[1]!.source.id, b: reads[2]!.source.id });
            if (!r.ok)
                return r;
            context = r.value;
        }
        const a = parseRunLog(ctx, reads[1]!.source.id, 'a', context);
        if (!a.ok)
            return a;
        const b = parseRunLog(ctx, reads[2]!.source.id, 'b', context);
        if (!b.ok)
            return b;
        let cacheList: AnalysisInputs['cacheList'];
        if (paths.cacheList !== undefined) {
            const r = parseCacheList(ctx, reads.find(r => r.source.kind === 'cache-list')!.source.id, context);
            if (!r.ok)
                return r;
            cacheList = r.value;
        }
        const inputs: AnalysisInputs = { sources: reads.map(r => r.source), excerpts: s.excerpts, workflow: wf.value, runs: [a.value, b.value], ...(context ? { context } : {}), ...(cacheList ? { cacheList } : {}), profile, diagnostics: [] };
        requestJsonStructureAnchors(ctx, inputs);
        const slot = new Map(inputs.sources.map((source, i) => [source.id, i]));
        inputs.excerpts.sort((a, b) => slot.get(a.ref.sourceId)! - slot.get(b.ref.sourceId)! || a.ref.startLine - b.ref.startLine || a.ref.endLine - b.ref.endLine || (a.lines[0]?.parts[0]?.startColumn ?? 0) - (b.lines[0]?.parts[0]?.startColumn ?? 0) || a.id.localeCompare(b.id));
        check(a.value.observations.length + b.value.observations.length + (context?.steps.reduce((n, step) => n + step.evidence.length, 0) ?? 0), LIMITS.observations, 'OBSERVATION_LIMIT');
        validateSafeTree(inputs, s);
        validateModel(inputs);
        freeze(inputs);
        trusted.add(inputs);
        const guard = Object.freeze({ [guardBrand]: true as const, toJSON: privateJSON });
        guards.set(guard, reads.map(r => r.identity));
        guardInputs.set(guard, inputs);
        return ok({ inputs, guard });
    }
    catch (e) {
        return errorResult(e);
    }
    finally {
        if (s) {
            s.active = false;
            s.raw.clear();
        }
    }
}
function validateModel(inputs: AnalysisInputs): void {
    for (const step of inputs.workflow.steps) {
        if (!Array.isArray(step.actionRefRefs) || !step.actionRefRefs.length || step.actionRefRefs.some(ref => ref.sourceId !== inputs.workflow.sourceId || ref.jsonPointer !== undefined || !inputs.excerpts.some(e => e.ref.sourceId === ref.sourceId && e.lines.some(l => l.line >= ref.startLine && l.line <= ref.endLine && l.parts.length))))
            throw new SafeFailure('MODEL_REFERENCE_INVALID');
    }
    const seen = new Set<string>();
    const register = (x: {
        id: string;
    }) => {
        if (seen.has(x.id))
            throw new SafeFailure('DUPLICATE_ID');
        seen.add(x.id);
    };
    inputs.sources.forEach(register);
    inputs.excerpts.forEach(register);
    inputs.workflow.diagnostics.forEach(register);
    inputs.runs.forEach(r => { r.blocks.forEach(register); r.observations.forEach(register); r.diagnostics.forEach(register); });
    inputs.cacheList?.entries.forEach(register);
    inputs.cacheList?.diagnostics.forEach(register);
    inputs.context?.diagnostics.forEach(register);
    inputs.context?.steps.forEach(step => { register(step); step.regions.forEach(register); step.evidence.forEach(register); });
    inputs.profile.codeSources.forEach(register);
    inputs.profile.patterns.forEach(register);
    inputs.profile.entries.forEach(register);
    register(inputs.profile);
    for (const run of inputs.runs) {
        const observations = new Set(run.observations.map(o => o.id));
        for (const b of run.blocks) {
            if (b.observationIds.some(x => !observations.has(x)) || b.parentCandidates.some(x => !run.blocks.some(b => b.id === x)))
                throw new SafeFailure('MODEL_REFERENCE_INVALID');
        }
    }
}
export function assertTrustedInputs(inputs: AnalysisInputs): Result<null> {
    if (!inputs || !trusted.has(inputs))
        return fail('UNTRUSTED_INPUTS');
    try {
        validateModel(inputs);
        if (!Object.isFrozen(inputs))
            return fail('MODEL_NOT_FROZEN');
        return ok(null);
    }
    catch (e) {
        return errorResult(e);
    }
}
export function jsonRef(sourceId: Id, ptr: string, nodes: Map<string, {
    start: number;
    end: number;
}>, offsets: {
    starts: number[];
}): SourceRef {
    const n = nodes.get(ptr);
    if (!n)
        throw new SafeFailure('JSON_NODE_INVALID');
    return { sourceId, startLine: lineAt(offsets.starts, n.start), endLine: lineAt(offsets.starts, Math.max(n.start, n.end - 1)), jsonPointer: ptr };
}
function requestNode(ctx: ParseContext, ref: SourceRef, nodes: Map<string, {
    start: number;
    end: number;
}>, offsets: OffsetTable): void {
    const n = nodes.get(ref.jsonPointer!)!;
    const parts = [];
    for (let line = ref.startLine; line <= ref.endLine; line++) {
        const start = Math.max(n.start, offsets.starts[line - 1]!);
        const end = Math.min(n.end, offsets.ends[line - 1]!);
        const lineStart = offsets.starts[line - 1]!;
        parts.push({ line, startColumn: Array.from(offsets.lines[line - 1]!.slice(0, start - lineStart)).length, endColumn: Array.from(offsets.lines[line - 1]!.slice(0, end - lineStart)).length });
    }
    // Split long nodes along physical lines/parts; schema-level values are requested rather than entire JSON roots.
    for (const p of parts) {
        const cps = Array.from(offsets.lines[p.line - 1]!);
        let start = p.startColumn;
        while (start < p.endColumn) {
            let end = start, size = 0;
            while (end < p.endColumn && size + Buffer.byteLength(cps[end]!) <= LIMITS.excerptSize) {
                size += Buffer.byteLength(cps[end]!);
                end++;
            }
            const r = ctx.requestExcerpt(ref, [{ line: p.line, startColumn: start, endColumn: end }]);
            if (!r.ok)
                throw new SafeFailure(r.diagnostics[0]!.code, r.diagnostics[0]!.category);
            start = end;
        }
    }
}
export { requestNode as requestJsonExcerpt };
function requestMapping(ctx: ParseContext, parent: SourceRef, pointers: string[], nodes: Map<string, {
    start: number;
    end: number;
}>, offsets: OffsetTable): void {
    const parts = pointers.filter(p => nodes.has(p)).map(p => {
        const n = nodes.get(p)!;
        const line = lineAt(offsets.starts, n.start);
        if (line !== lineAt(offsets.starts, n.end - 1))
            throw new SafeFailure('JSON_NODE_INVALID');
        const base = offsets.starts[line - 1]!;
        return { line, startColumn: Array.from(offsets.lines[line - 1]!.slice(0, n.start - base)).length, endColumn: Array.from(offsets.lines[line - 1]!.slice(0, n.end - base)).length };
    });
    const r = ctx.requestExcerpt(parent, parts);
    if (!r.ok)
        throw new SafeFailure(r.diagnostics[0]!.code, r.diagnostics[0]!.category);
}
function requiredPresence(ctx: ParseContext, field: Field, v: unknown, ref: SourceRef): Presence<any> { return ctx.sanitizeField(field, v, [ref]); }
function fieldLeaves(field: Field, value: unknown, ptr: string): string[] {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        return [ptr];
    if (Array.isArray(value))
        return value.flatMap((v, i) => fieldLeaves(field, v, ptr + '/' + i));
    if (!object(value))
        return [];
    if (field === 'lockfileError')
        return ['path', 'reason', 'pathBasis'].map(k => ptr + '/' + k);
    if (field === 'saveReason')
        return ['class', 'code'].map(k => ptr + '/' + k);
    if (field === 'keyLayout' && Array.isArray(value.parts))
        return value.parts.flatMap((part, i) => {
            if (!object(part))
                return [];
            const p = ptr + `/parts/${i}`;
            const refs = [p + '/kind'];
            if (part.kind === 'literal') {
                for (const k of ['keyStart', 'keyEnd'])
                    refs.push(p + '/' + k);
                if (object(part.text)) {
                    refs.push(p + '/text/state');
                    if (part.text.state === 'value')
                        refs.push(p + '/text/value');
                }
            }
            else if (object(part.variable)) {
                const v = part.variable;
                for (const k of ['kind', 'keyStart', 'keyEnd'])
                    refs.push(p + '/variable/' + k);
                for (const k of ['expression', 'resolved']) {
                    const a = v[k];
                    if (object(a)) {
                        refs.push(p + '/variable/' + k + '/state');
                        if (a.state === 'value')
                            refs.push(p + '/variable/' + k + '/value');
                    }
                }
            }
            return refs;
        });
    return [];
}
export function resolveTarget(workflow: ParsedWorkflow, target: unknown): StepTarget {
    if (!object(target))
        throw new SafeFailure('CONTEXT_TARGET_INVALID');
    if (typeof target.stepRef === 'string' && Object.keys(target).length === 1) {
        if (!workflow.steps.some(s => s.stepRef === target.stepRef))
            throw new SafeFailure('CONTEXT_TARGET_NOT_FOUND');
        return { stepRef: target.stepRef };
    }
    const p = safeString(String(target.jobId ?? ''));
    if (p.state !== 'value')
        throw new SafeFailure('CONTEXT_TARGET_INVALID');
    const choices = workflow.steps.filter(s => s.jobId.state === 'value' && s.jobId.value === p.value);
    if (integer(target.stepIndex) && Object.keys(target).every(k => ['jobId', 'stepIndex'].includes(k))) {
        if (!choices.some(s => s.stepIndex === target.stepIndex))
            throw new SafeFailure('CONTEXT_TARGET_NOT_FOUND');
        return { jobId: p.value, stepIndex: target.stepIndex };
    }
    if (typeof target.stepId === 'string' && Object.keys(target).every(k => ['jobId', 'stepId'].includes(k))) {
        const step = safeString(target.stepId);
        if (step.state !== 'value' || !choices.some(s => s.stepId.state === 'value' && s.stepId.value === step.value))
            throw new SafeFailure('CONTEXT_TARGET_NOT_FOUND');
        return { jobId: p.value, stepId: step.value };
    }
    throw new SafeFailure('CONTEXT_TARGET_INVALID');
}
export function targetsStep(t: StepTarget, s: ParsedWorkflow['steps'][number]): boolean { return 'stepRef' in t ? t.stepRef === s.stepRef : s.jobId.state === 'value' && s.jobId.value === t.jobId && ('stepIndex' in t ? s.stepIndex === t.stepIndex : s.stepId.state === 'value' && s.stepId.value === t.stepId); }
export function parseContext(ctx: ParseContext, sourceId: Id, workflow: ParsedWorkflow, runs: {
    a: Id;
    b: Id;
}): Result<Context> {
    const guard = validateParseContext(ctx, sourceId, 'context');
    if (!guard.ok)
        return guard;
    return ctx.withSource(sourceId, (text, offsets) => {
        const j = parseJson(text, () => { });
        if (!object(j.value) || j.value.schemaVersion !== 1 || !object(j.value.runs) || !object(j.value.runs.a) || !object(j.value.runs.b) || !Array.isArray(j.value.runs.a.steps) || !Array.isArray(j.value.runs.b.steps))
            throw new SafeFailure('CONTEXT_SCHEMA_INVALID');
        const result: Context = { sourceId, steps: [], diagnostics: [] };
        const ref = (ptr: string) => jsonRef(sourceId, ptr, j.nodes, offsets);
        const token = (ptr: string) => { const r = ref(ptr); requestNode(ctx, r, j.nodes, offsets); return r; };
        for (const runId of ['a', 'b'] as RunId[]) {
            const list = (j.value.runs[runId] as {
                steps: unknown[];
            }).steps;
            const regionIds = new Map<string, ContextRegion>();
            list.forEach((item, si) => {
                if (!object(item) || !Array.isArray(item.regions) || !Array.isArray(item.evidence))
                    throw new SafeFailure('CONTEXT_STEP_INVALID');
                const ptr = `/runs/${runId}/steps/${si}`;
                const target = resolveTarget(workflow, item.target);
                const targetRef = ref(ptr + '/target');
                requestMapping(ctx, targetRef, Object.keys(target).map(k => ptr + '/target/' + k), j.nodes, offsets);
                const step: ContextStep = { id: id('context-step', [sourceId, ptr]), runId, target, refs: [targetRef], regions: [], evidence: [], saveTargets: [] };
                item.regions.forEach((r, ri) => {
                    if (!object(r) || typeof r.id !== 'string' || !r.id || !['main', 'post', 'save'].includes(r.phase as string) || !integer(r.startLine) || !integer(r.endLine) || (r.complete !== undefined && typeof r.complete !== 'boolean') || (r.parentRegionId !== undefined && typeof r.parentRegionId !== 'string'))
                        throw new SafeFailure('CONTEXT_REGION_INVALID');
                    if (regionIds.has(r.id))
                        throw new SafeFailure('REGION_ID_DUPLICATE');
                    const p = ptr + `/regions/${ri}`;
                    const range = { sourceId: runs[runId], startLine: r.startLine, endLine: r.endLine };
                    const declarationRef = ref(p);
                    requestMapping(ctx, declarationRef, ['phase', 'startLine', 'endLine', 'complete'].map(k => p + '/' + k), j.nodes, offsets);
                    const valid = ctx.requestExcerpt(range, [{ line: r.startLine, startColumn: 0, endColumn: 0 }, ...(r.endLine === r.startLine ? [] : [{ line: r.endLine, startColumn: 0, endColumn: 0 }])]);
                    if (!valid.ok)
                        throw new SafeFailure(valid.diagnostics[0]!.code);
                    const region: ContextRegion = { id: id('region', [sourceId, p]), phase: r.phase as ContextRegion['phase'], range, declarationRef, completeness: { state: r.complete === true ? 'complete' : r.complete === false ? 'incomplete' : 'unknown', basis: r.complete === undefined ? 'none' : 'user_provided', refs: [declarationRef] } };
                    if (r.parentRegionId !== undefined)
                        Object.assign(region, { parentRegionId: r.parentRegionId });
                    regionIds.set(r.id, region);
                    step.regions.push(region);
                });
                item.evidence.forEach((e, ei) => {
                    if (!object(e) || typeof e.field !== 'string')
                        throw new SafeFailure('CONTEXT_EVIDENCE_INVALID');
                    if (e.field === 'resolvedKey')
                        throw new SafeFailure('UNKNOWN_FIELD_ALIAS');
                    if (!fields.includes(e.field as Field))
                        return;
                    const field = e.field as Field;
                    const p = ptr + `/evidence/${ei}`;
                    if (!['value', 'missing', 'empty', 'masked'].includes(e.state as string) || (e.state === 'value') !== Object.hasOwn(e, 'value'))
                        throw new SafeFailure('CONTEXT_EVIDENCE_INVALID');
                    if (field === 'cacheHit' && e.state !== 'value' && e.state !== 'masked')
                        throw new SafeFailure('CACHE_HIT_SCHEMA_INVALID');
                    const refs = [ref(e.state === 'value' ? p + '/value' : p + '/state')];
                    if (e.state === 'value')
                        fieldLeaves(field, e.value, p + '/value').forEach(token);
                    else
                        token(p + '/state');
                    if (e.logRanges !== undefined) {
                        if (!Array.isArray(e.logRanges))
                            throw new SafeFailure('CONTEXT_LOG_RANGES_INVALID');
                        e.logRanges.forEach((r, li) => {
                            if (!object(r) || !integer(r.startLine) || !integer(r.endLine))
                                throw new SafeFailure('SOURCE_REF_INVALID');
                            const lr = { sourceId: runs[runId], startLine: r.startLine, endLine: r.endLine };
                            const v = ctx.requestExcerpt(lr, [{ line: r.startLine, startColumn: 0, endColumn: 0 }]);
                            if (!v.ok)
                                throw new SafeFailure('SOURCE_REF_INVALID');
                            const dr = ref(p + `/logRanges/${li}`);
                            requestMapping(ctx, dr, ['startLine', 'endLine'].map(k => p + `/logRanges/${li}/` + k), j.nodes, offsets);
                            refs.push(dr, lr);
                        });
                    }
                    let val: Presence<any> = e.state === 'value' ? requiredPresence(ctx, field, e.value, refs[0]!) : { state: e.state as 'missing' | 'empty' | 'masked' };
                    if (field === 'keyLayout' && val.state === 'value') {
                        val.value.parts.forEach((part: any, pi: number) => {
                            if (part.kind === 'variable')
                                part.variable.refs = [ref(p + `/value/parts/${pi}/variable`)];
                        });
                    }
                    step.evidence.push({ id: id('observation', [sourceId, p, field, ei]), runId, field, value: val, status: val.state === 'masked' ? 'unknown' : 'candidate', refs, origin: 'user_provided', verification: 'user_declared' } as Observation);
                });
                if (item.saveTargets !== undefined) {
                    if (!Array.isArray(item.saveTargets))
                        throw new SafeFailure('SAVE_TARGET_INVALID');
                    item.saveTargets.forEach((t, ti) => { step.saveTargets.push({ target: resolveTarget(workflow, t), refs: [ref(ptr + `/saveTargets/${ti}`)] }); });
                }
                result.steps.push(step);
            });
            for (const r of regionIds.values()) {
                if (r.parentRegionId !== undefined) {
                    const parent = regionIds.get(r.parentRegionId);
                    if (!parent || parent === r || r.phase === 'main' || parent.phase !== 'main')
                        throw new SafeFailure('REGION_PARENT_INVALID');
                    r.parentRegionId = parent.id;
                }
            }
            for (let i = 0; i < result.steps.length; i++) {
                const a = result.steps[i]!;
                if (a.runId !== runId)
                    continue;
                for (let k = i + 1; k < result.steps.length; k++) {
                    const b = result.steps[k]!;
                    if (b.runId !== runId)
                        continue;
                    for (const ar of a.regions)
                        for (const br of b.regions)
                            if (ar.range.startLine <= br.range.endLine && br.range.startLine <= ar.range.endLine) {
                                ar.completeness.state = 'conflict';
                                br.completeness.state = 'conflict';
                                result.diagnostics.push(diagnostic('CONTEXT_OVERLAP', 'context', 'conflict', [ar.declarationRef, br.declarationRef]));
                            }
                }
            }
        }
        if (j.value.cacheList !== undefined) {
            if (!object(j.value.cacheList))
                throw new SafeFailure('PAGINATION_SCHEMA_INVALID');
            const c = j.value.cacheList;
            const p = '/cacheList';
            if (c.allPages !== undefined && typeof c.allPages !== 'boolean' || c.expectedCount !== undefined && !integer(c.expectedCount))
                throw new SafeFailure('PAGINATION_SCHEMA_INVALID');
            const scope: ListScope = { repository: { state: 'missing' }, ref: { state: 'missing' }, observedAt: { state: 'missing' } };
            if (c.scope !== undefined) {
                if (!object(c.scope))
                    throw new SafeFailure('SCOPE_SCHEMA_INVALID');
                for (const k of ['repository', 'ref', 'observedAt'] as const) {
                    const v = c.scope[k];
                    if (v !== undefined) {
                        if (typeof v !== 'string' || k === 'observedAt' && !validTime(v))
                            throw new SafeFailure('SCOPE_SCHEMA_INVALID');
                        scope[k] = sanitizeSourceText(ctx, v, ref(p + '/scope/' + k));
                        token(p + '/scope/' + k);
                    }
                }
            }
            const pagination: Pagination = { state: 'unknown', allPages: c.allPages === undefined ? { state: 'missing' } : { state: 'value', value: c.allPages as boolean }, expectedCount: c.expectedCount === undefined ? { state: 'missing' } : { state: 'value', value: c.expectedCount as number }, importedCount: 0, refs: [ref(p)], origin: 'user_provided' };
            result.cacheList = { pagination, scope, refs: [ref(p)] };
        }
        return result;
    });
}
export function validTime(s: string): boolean { return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/.test(s) && Number.isFinite(Date.parse(s.endsWith('Z') || /[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z')); }
async function verifyInputs(g: InputGuard): Promise<void> {
    const identities = guards.get(g);
    if (!identities)
        throw new SafeFailure('INPUT_GUARD_INVALID');
    for (const old of identities) {
        const kind = old.slot.startsWith('log-') ? 'log' : old.slot as SourceKind;
        const now = await readBounded(old.canonicalAbsolutePath, old.slot, kind);
        if (now.identity.realPath !== old.realPath || !sameFile(now.identity.file, old.file) || now.identity.sha256 !== old.sha256 || now.identity.size !== old.size || now.identity.mtimeNs !== old.mtimeNs || now.identity.ctimeNs !== old.ctimeNs)
            throw new SafeFailure('INPUT_CHANGED', 'io');
    }
}
async function pathPlan(g: InputGuard, requests: OutputRequest[], overwrite: boolean, root?: string): Promise<OutputPlan['entries']> {
    const identities = guards.get(g);
    if (!identities)
        throw new SafeFailure('INPUT_GUARD_INVALID');
    const entries: OutputPlan['entries'] = [];
    const rootReal = root === undefined ? undefined : await realpath(resolve(root));
    for (const r of requests) {
        if (!object(r) || !['html', 'json'].includes(r.kind) || typeof r.path !== 'string' || !r.path || r.path === '-' || Object.keys(r).some(k => !['kind', 'path'].includes(k)))
            throw new SafeFailure('OUTPUT_REQUEST_INVALID');
        if (root !== undefined && r.path.split(/[\\/]/).includes('..'))
            throw new SafeFailure('OUTPUT_ROOT_ESCAPE');
        const canonicalPath = resolve(r.path);
        const parentRealPath = await realpath(dirname(canonicalPath));
        const parent = await stat(parentRealPath, { bigint: true });
        if (!parent.isDirectory() || parent.ino === 0n)
            throw new SafeFailure('OUTPUT_PARENT_UNSAFE');
        const effective = resolve(parentRealPath, basename(canonicalPath));
        if (rootReal !== undefined) {
            const rel = relative(rootReal, effective);
            if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
                throw new SafeFailure('OUTPUT_ROOT_ESCAPE');
        }
        if (identities.some(i => norm(i.canonicalAbsolutePath) === norm(canonicalPath) || norm(i.realPath) === norm(effective)))
            throw new SafeFailure('OUTPUT_INPUT_ALIAS');
        let existing: FileIdentity | undefined;
        try {
            const s = await lstat(canonicalPath, { bigint: true });
            if (s.isSymbolicLink())
                throw new SafeFailure('OUTPUT_LEAF_LINK');
            if (!s.isFile())
                throw new SafeFailure('OUTPUT_NOT_FILE');
            existing = fileId(s);
            if (existing.fileId === '0')
                throw new SafeFailure('OUTPUT_IDENTITY_UNAVAILABLE');
            if (identities.some(i => sameFile(i.file, existing!)))
                throw new SafeFailure('OUTPUT_INPUT_ALIAS');
        }
        catch (e) {
            if (!(object(e) && e.code === 'ENOENT'))
                throw e;
        }
        if (entries.some(e => norm(e.canonicalPath) === norm(canonicalPath) || norm(resolve(e.parentRealPath, basename(e.canonicalPath))) === norm(effective) || existing && e.existing && sameFile(existing, e.existing)))
            throw new SafeFailure('OUTPUT_COLLISION');
        if (existing && identities.some(i => i.file.fileId === '0'))
            throw new SafeFailure('OUTPUT_IDENTITY_UNAVAILABLE');
        if (existing && !overwrite)
            throw new SafeFailure('OUTPUT_EXISTS');
        entries.push({ kind: r.kind, canonicalPath, parentRealPath, parentIdentity: fileId(parent), ...(existing ? { existing } : {}), mode: existing ? 'atomic-replace' : 'exclusive-create' });
    }
    return entries;
}
export async function prepareOutputs(loaded: LoadedInputs, requests: OutputRequest[], options: {
    overwrite: boolean;
    outputRoot?: string;
}): Promise<Result<OutputPermit>> {
    try {
        if (!loaded || !guards.has(loaded.guard) || !trusted.has(loaded.inputs) || guardInputs.get(loaded.guard) !== loaded.inputs)
            return fail('INPUT_GUARD_INVALID', 'output');
        if (!Array.isArray(requests) || !object(options) || typeof options.overwrite !== 'boolean' || options.outputRoot !== undefined && typeof options.outputRoot !== 'string')
            return fail('OUTPUT_OPTIONS_INVALID', 'output');
        const entries = await pathPlan(loaded.guard, requests, options.overwrite, options.outputRoot);
        await verifyInputs(loaded.guard);
        const permit: OutputPermit = Object.freeze({ [permitBrand]: true as const, toJSON: privateJSON });
        const data: PermitData = { guard: loaded.guard, requests: requests.map(r => ({ ...r, path: resolve(r.path) })), plan: { entries, permit }, overwrite: options.overwrite, ...(options.outputRoot === undefined ? {} : { root: resolve(options.outputRoot) }) };
        permits.set(permit, data);
        return ok(permit);
    }
    catch (e) {
        return errorResult(e, 'output');
    }
}
export async function revalidateOutputPermit(permit: OutputPermit): Promise<Result<OutputPlan>> {
    try {
        const data = permits.get(permit);
        if (!data)
            return fail('OUTPUT_PERMIT_INVALID', 'output');
        await verifyInputs(data.guard);
        const fresh = await pathPlan(data.guard, data.requests, data.overwrite, data.root);
        for (let i = 0; i < fresh.length; i++) {
            const a = fresh[i]!, b = data.plan.entries[i]!;
            if (a.parentRealPath !== b.parentRealPath || !sameFile(a.parentIdentity, b.parentIdentity) || !!a.existing !== !!b.existing || a.existing && b.existing && !sameFile(a.existing, b.existing))
                return fail('OUTPUT_CHANGED', 'output', 'io');
        }
        return ok(freeze({ entries: fresh, permit }));
    }
    catch (e) {
        return errorResult(e, 'output');
    }
}
export function validateOutputPayloads(permit: OutputPermit, payloads: OutputPayload[], stdoutBytes = 0): Result<null> {
    try {
        const p = permits.get(permit);
        if (!p || !Array.isArray(payloads) || payloads.length !== p.requests.length || !integer(stdoutBytes))
            return fail('OUTPUT_PAYLOAD_INVALID', 'output');
        let total = stdoutBytes;
        for (let i = 0; i < payloads.length; i++) {
            const x = payloads[i]!;
            if (x.kind !== p.requests[i]!.kind || !(x.utf8 instanceof Uint8Array))
                return fail('OUTPUT_PAYLOAD_INVALID', 'output');
            check(x.utf8.byteLength, LIMITS[x.kind], 'OUTPUT_SIZE_LIMIT');
            total += x.utf8.byteLength;
        }
        check(total, LIMITS.outputs, 'OUTPUT_TOTAL_LIMIT');
        return ok(null);
    }
    catch (e) {
        return errorResult(e, 'output');
    }
}

// Single-use output ownership bridge. This is internal; no source text leaves the loader.
const outputSessionBrand: unique symbol = Symbol('output-session');
export interface OutputSession {
    readonly [outputSessionBrand]: true;
    toJSON(): never;
}
interface OwnedOutput {
    handle: import('node:fs/promises').FileHandle;
    path: string;
    identity: FileIdentity;
    state: 'open' | 'ready' | 'committed';
    sha256?: string;
    size?: number;
}
interface OutputSessionData {
    permit: OutputPermit;
    payloads: OutputPayload[];
    owned: Map<number, OwnedOutput>;
    staging: string[];
    active: boolean;
}
const outputSessions = new WeakMap<OutputSession, OutputSessionData>();
const consumedPermits = new WeakSet<OutputPermit>();
export function beginOutputSession(permit: OutputPermit, payloads: OutputPayload[]): Result<OutputSession> {
    try {
        if (!permits.has(permit))
            return fail('OUTPUT_PERMIT_INVALID', 'output');
        if (consumedPermits.has(permit))
            return fail('OUTPUT_PERMIT_CONSUMED', 'output');
        consumedPermits.add(permit);
        const valid = validateOutputPayloads(permit, payloads);
        if (!valid.ok)
            return valid;
        const p = permits.get(permit)!;
        // Snapshot before the first await: later caller mutations cannot alter bytes or budgets.
        const snapshots = payloads.map(x => ({ kind: x.kind, utf8: Uint8Array.from(x.utf8) }));
        const snapshotValid = validateOutputPayloads(permit, snapshots);
        if (!snapshotValid.ok)
            return snapshotValid;
        const capability: OutputSession = Object.freeze({ [outputSessionBrand]: true as const, toJSON: privateJSON });
        const staging = p.plan.entries.map(e => resolve(e.parentRealPath, '.cachescope-' + randomUUID() + '.tmp'));
        outputSessions.set(capability, { permit, payloads: snapshots, owned: new Map(), staging, active: true });
        return ok(capability);
    }
    catch {
        return fail('OUTPUT_SESSION_INVALID', 'output');
    }
}
function outputSession(s: OutputSession): OutputSessionData { const d = outputSessions.get(s); if (!d?.active)
    throw new SafeFailure('OUTPUT_SESSION_INVALID'); return d; }
export function outputSessionPlan(s: OutputSession): Result<{
    entries: OutputPlan['entries'];
    staging: string[];
    payloads: OutputPayload[];
}> {
    try {
        const d = outputSession(s);
        return ok({ entries: permits.get(d.permit)!.plan.entries.map(e => ({ ...e })), staging: [...d.staging], payloads: d.payloads.map(p => ({ kind: p.kind, utf8: Uint8Array.from(p.utf8) })) });
    }
    catch {
        return fail('OUTPUT_SESSION_INVALID', 'output');
    }
}
async function ownedState(o: OwnedOutput, path: string, checkContent: boolean): Promise<void> {
    const current = await lstat(path, { bigint: true });
    const held = await o.handle.stat({ bigint: true });
    if (current.isSymbolicLink() || !current.isFile() || !sameFile(fileId(current), o.identity) || !sameFile(fileId(held), o.identity))
        throw new SafeFailure('OUTPUT_CHANGED', 'io');
    if (checkContent) {
        const size = Number(held.size);
        if (size !== o.size)
            throw new SafeFailure('OUTPUT_CHANGED', 'io');
        const bytes = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
            const r = await o.handle.read(bytes, offset, size - offset, offset);
            if (!r.bytesRead)
                throw new SafeFailure('OUTPUT_CHANGED', 'io');
            offset += r.bytesRead;
        }
        const after = await o.handle.stat({ bigint: true });
        if (hash(bytes) !== o.sha256 || after.mtimeNs !== held.mtimeNs || after.ctimeNs !== held.ctimeNs)
            throw new SafeFailure('OUTPUT_CHANGED', 'io');
    }
}
export async function registerOutputHandle(s: OutputSession, index: number, handle: import('node:fs/promises').FileHandle): Promise<Result<null>> {
    try {
        const d = outputSession(s);
        if (!integer(index) || index >= d.staging.length || d.owned.has(index))
            throw new SafeFailure('OUTPUT_OWNERSHIP_INVALID');
        const path = d.staging[index]!;
        const a = await handle.stat({ bigint: true }), b = await lstat(path, { bigint: true });
        if (!a.isFile() || a.size !== 0n || a.ino === 0n || b.isSymbolicLink() || !sameFile(fileId(a), fileId(b)))
            throw new SafeFailure('OUTPUT_OWNERSHIP_INVALID');
        d.owned.set(index, { handle, path, identity: fileId(a), state: 'open' });
        return ok(null);
    }
    catch {
        return fail('OUTPUT_OWNERSHIP_INVALID', 'output', 'io');
    }
}
export async function sealOutputHandle(s: OutputSession, index: number): Promise<Result<null>> {
    try {
        const d = outputSession(s), o = d.owned.get(index);
        if (!o || o.state !== 'open')
            throw new SafeFailure('OUTPUT_OWNERSHIP_INVALID');
        o.sha256 = hash(d.payloads[index]!.utf8);
        o.size = d.payloads[index]!.utf8.byteLength;
        await ownedState(o, o.path, true);
        o.state = 'ready';
        return ok(null);
    }
    catch {
        return fail('OUTPUT_CHANGED', 'output', 'io');
    }
}
export async function validateOutputSession(s: OutputSession): Promise<Result<null>> {
    try {
        const d = outputSession(s), p = permits.get(d.permit)!;
        await verifyInputs(p.guard);
        // Re-run alias/collision/root/leaf checks for the complete destination set.
        const fresh = await pathPlan(p.guard, p.requests, true, p.root);
        for (let i = 0; i < fresh.length; i++) {
            const a = fresh[i]!, b = p.plan.entries[i]!, o = d.owned.get(i);
            if (a.parentRealPath !== b.parentRealPath || !sameFile(a.parentIdentity, b.parentIdentity))
                throw new SafeFailure('OUTPUT_CHANGED', 'io');
            if (o?.state === 'committed') {
                if (!a.existing || !sameFile(a.existing, o.identity))
                    throw new SafeFailure('OUTPUT_CHANGED', 'io');
                await ownedState(o, a.canonicalPath, true);
            }
            else {
                if (!!a.existing !== !!b.existing || a.existing && b.existing && !sameFile(a.existing, b.existing))
                    throw new SafeFailure('OUTPUT_CHANGED', 'io');
                if (o)
                    await ownedState(o, o.path, o.state === 'ready');
            }
        }
        return ok(null);
    }
    catch (e) {
        return errorResult(e, 'output');
    }
}
export async function commitOutputHandle(s: OutputSession, index: number): Promise<Result<null>> {
    try {
        const d = outputSession(s), o = d.owned.get(index);
        if (!o || o.state !== 'ready')
            throw new SafeFailure('OUTPUT_OWNERSHIP_INVALID');
        const e = permits.get(d.permit)!.plan.entries[index]!;
        await ownedState(o, e.canonicalPath, true);
        o.state = 'committed';
        return ok(null);
    }
    catch {
        return fail('OUTPUT_CHANGED', 'output', 'io');
    }
}
export async function cleanupOutputSession(s: OutputSession): Promise<void> {
    const d = outputSessions.get(s);
    if (!d)
        return;
    d.active = false;
    // Cleanup is limited to recorded temporary identities; final destinations are preserved.
    for (const o of d.owned.values()) {
        try {
            const a = await lstat(o.path, { bigint: true });
            if (!a.isSymbolicLink() && sameFile(fileId(a), o.identity))
                await unlink(o.path);
        }
        catch { }
        try {
            await o.handle.close();
        }
        catch { }
    }
}


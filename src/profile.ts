import data from '../compatibility.json' with { type: 'json' };
import type { Compatibility } from './model.ts';
import { SafeFailure, freeze, fields, object, fieldSchema } from './safety.ts';
function closed(x: unknown, keys: string[]): void { if (!object(x) || Object.keys(x).some(k => !keys.includes(k)))
    throw new SafeFailure('PROFILE_SCHEMA_INVALID'); }
// Trusted shipped schema, independently checked at module load without IO.
function validate(): Compatibility {
    const profile = data as unknown as Compatibility;
    const ids = new Set<string>();
    const add = (x: {
        id: string;
    }) => {
        if (!x.id || ids.has(x.id))
            throw new SafeFailure('PROFILE_ID_INVALID');
        ids.add(x.id);
    };
    if (profile.schemaVersion !== 1)
        throw new SafeFailure('PROFILE_SCHEMA_INVALID');
    closed(profile, ['schemaVersion', 'id', 'codeSources', 'entries', 'patterns']);
    profile.codeSources.forEach(s => { closed(s, ['id', 'repository', 'commit', 'path', 'url', 'startLine', 'endLine', 'statement', 'contentSha256']); if (!['actions/cache', 'actions/setup-node', 'actions/runner'].includes(s.repository))
        throw new SafeFailure('PROFILE_SOURCE_INVALID'); });
    profile.patterns.forEach(p => { closed(p, ['id', 'sourceId', 'actionKinds', 'phase', 'role', 'segments', 'outputs', 'acceptedPrefixes', 'multiline', 'anchor', 'coverage', 'fixtureIds']); if (!['main', 'post', 'save'].includes(p.phase) || !['observation', 'block-open', 'block-close', 'parent-link', 'execution-commit', 'input-component'].includes(p.role) || p.actionKinds.some(k => !['cache', 'restore', 'save', 'setup-node'].includes(k)) || p.acceptedPrefixes.some(k => !['none', 'iso8601-space', 'runner-group'].includes(k)))
        throw new SafeFailure('PROFILE_PATTERN_INVALID'); });
    profile.codeSources.forEach(s => {
        add(s);
        if (!/^[a-f0-9]{40}$/.test(s.commit) || !/^[a-f0-9]{64}$/.test(s.contentSha256) || s.startLine < 1 || s.endLine < s.startLine || s.url !== `https://raw.githubusercontent.com/${s.repository}/${s.commit}/${s.path}`)
            throw new SafeFailure('PROFILE_SOURCE_INVALID');
    });
    profile.patterns.forEach(p => {
        add(p);
        if (!profile.codeSources.some(s => s.id === p.sourceId) || p.anchor !== 'whole-line' || p.multiline !== false)
            throw new SafeFailure('PROFILE_PATTERN_INVALID');
        const captures = new Set<string>();
        p.segments.forEach((s, i) => {
            if ('capture' in s) {
                closed(s, ['capture', 'codec', 'separator']);
                if (!['text', 'key', 'boolean', 'sha40', 'path-list', 'save-outcome'].includes(s.codec))
                    throw new SafeFailure('PROFILE_CODEC_INVALID');
                if (captures.has(s.capture) || i > 0 && 'capture' in p.segments[i - 1]!)
                    throw new SafeFailure('PROFILE_CAPTURE_INVALID');
                captures.add(s.capture);
                if (s.codec === 'path-list' ? !s.separator : s.separator !== undefined)
                    throw new SafeFailure('PROFILE_CODEC_INVALID');
            }
            else
                closed(s, ['literal']);
        });
        p.outputs.forEach(o => {
            closed(o, ['field', 'from']);
            if (!fields.includes(o.field as any) && !['jobId', 'stepId', 'stepIndex', 'parentId', 'dependencyPathInput'].includes(o.field))
                throw new SafeFailure('PROFILE_FIELD_INVALID');
            if (o.from.kind === 'capture' && !captures.has(o.from.name) || o.from.kind === 'decoder' && o.from.id !== p.id)
                throw new SafeFailure('PROFILE_OUTPUT_INVALID');
            if (o.from.kind === 'capture')
                closed(o.from, ['kind', 'name']);
            else if (o.from.kind === 'constant') {
                closed(o.from, ['kind', 'value']);
                if (fields.includes(o.field as any) && !fieldSchema(o.field as any, o.from.value))
                    throw new SafeFailure('PROFILE_OUTPUT_INVALID');
            }
            else if (o.from.kind === 'decoder') {
                closed(o.from, ['kind', 'id', 'captures', 'components']);
                if (o.from.captures.some(c => !captures.has(c)))
                    throw new SafeFailure('PROFILE_OUTPUT_INVALID');
                if (o.from.components) {
                    if (o.field !== 'lockfileError' || o.from.components.length !== 1 || p.role !== 'observation')
                        throw new SafeFailure('PROFILE_COMPONENT_INVALID');
                    for (const c of o.from.components) {
                        closed(c, ['field', 'patternIds', 'scope', 'cardinality']);
                        if (c.field !== 'dependencyPathInput' || c.scope !== 'same-block' || c.cardinality !== 'one' || !c.patternIds.length || c.patternIds.some(pid => !profile.patterns.some(q => q.id === pid && q.role === 'input-component' && q.outputs.some(z => z.field === 'dependencyPathInput' && z.from.kind === 'capture') && profile.codeSources.some(s => s.id === q.sourceId && s.repository === 'actions/runner'))))
                            throw new SafeFailure('PROFILE_COMPONENT_INVALID');
                    }
                }
            }
            else
                throw new SafeFailure('PROFILE_OUTPUT_INVALID');
            if (o.field === 'dependencyPathInput' && (p.role !== 'input-component' || o.from.kind !== 'capture'))
                throw new SafeFailure('PROFILE_COMPONENT_INVALID');
        });
    });
    profile.entries.forEach(e => closed(e, ['id', 'actionKind', 'actionName', 'declaredRefs', 'sourceCommit', 'sourceIds', 'patternIds', 'limitations']));
    profile.entries.forEach(e => {
        add(e);
        if (e.sourceIds.some(x => !profile.codeSources.some(s => s.id === x)) || e.patternIds.some(x => !profile.patterns.some(p => p.id === x)))
            throw new SafeFailure('PROFILE_REFERENCE_INVALID');
    });
    return freeze(profile);
}
export const profile = validate();

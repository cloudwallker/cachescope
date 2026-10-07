export type Id = string;
export type Text = string & {
    readonly __safe: unique symbol;
};
export type RunId = 'a' | 'b';
export type Locale = 'zh-CN' | 'en';
export type Certainty = 'confirmed' | 'candidate' | 'unknown' | 'ambiguous' | 'conflict';
export type Presence<T> = {
    state: 'value';
    value: T;
} | {
    state: 'empty';
} | {
    state: 'missing';
} | {
    state: 'masked';
};
export type CacheHit = 'true' | 'false' | 'empty' | 'unrecorded';
export type ActionKind = 'cache' | 'restore' | 'save' | 'setup-node';
export type SourceKind = 'workflow' | 'log' | 'context' | 'cache-list';
export interface Source {
    id: Id;
    kind: SourceKind;
    label: Text;
    sha256: string;
    lineCount: number;
}
export interface SourceRef {
    sourceId: Id;
    startLine: number;
    endLine: number;
    jsonPointer?: string;
}
export interface EvidenceExcerpt {
    id: Id;
    ref: SourceRef;
    redacted: boolean;
    lines: {
        line: number;
        parts: {
            startColumn: number;
            endColumn: number;
            text: Text;
        }[];
    }[];
}
export interface Message {
    code: string;
    params: {
        name: string;
        value: Text;
    }[];
}
export interface MissingEvidence {
    code: string;
    field?: Field;
    runId?: RunId;
    stepRef?: Id;
}
export interface Diagnostic {
    id: Id;
    code: string;
    stage: 'input' | 'workflow' | 'log' | 'context' | 'cache-list' | 'association' | 'analysis' | 'render' | 'output';
    category: 'invalid' | 'io' | 'limit' | 'incomplete' | 'unverified' | 'conflict';
    label: Text;
    refs: SourceRef[];
    stepRef?: Id;
    message: Message;
}
export type Result<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    diagnostics: Diagnostic[];
};
export type InputName = 'key' | 'restore-keys' | 'path' | 'cache' | 'cache-dependency-path' | 'enableCrossOsArchive' | 'lookup-only' | 'fail-on-cache-miss' | 'package-manager-cache';
export interface WorkflowInput {
    name: InputName;
    value: Presence<Text>;
    form: 'literal' | 'expression' | 'mixed';
    refs: SourceRef[];
    expressions: {
        text: Presence<Text>;
        refs: SourceRef[];
    }[];
}
export interface WorkflowStep {
    stepRef: Id;
    jobIndex: number;
    jobId: Presence<Text>;
    stepIndex: number;
    stepId: Presence<Text>;
    range: SourceRef;
    actionKind: ActionKind;
    actionRef: Presence<Text>;
    actionRefRefs: SourceRef[];
    inputs: WorkflowInput[];
}
export interface InstallStep {
    stepRef: Id;
    jobIndex: number;
    stepIndex: number;
    range: SourceRef;
    packageManager: 'npm' | 'yarn' | 'pnpm';
    evidence: 'static-command';
}
export interface ParsedWorkflow {
    sourceId: Id;
    steps: WorkflowStep[];
    installSteps: InstallStep[];
    diagnostics: Diagnostic[];
}
export interface VariablePart {
    expression: Presence<Text>;
    resolved: Presence<Text>;
    kind: 'date' | 'other';
    keyStart: number;
    keyEnd: number;
    refs: SourceRef[];
}
export interface KeyLayout {
    parts: ({
        kind: 'literal';
        text: Presence<Text>;
        keyStart: number;
        keyEnd: number;
    } | {
        kind: 'variable';
        variable: VariablePart;
    })[];
}
export type SaveOutcome = 'saved' | 'skipped' | 'write-denied' | 'error';
export interface FieldValues {
    primaryKey: Text;
    restoredKey: Text;
    restoreKeys: Text[];
    runnerOS: Text;
    ref: Text;
    defaultBranch: Text;
    resolvedPaths: Text[];
    actionRef: Text;
    executedCommit: Text;
    lockfileMatches: Text[];
    lockfileHash: Text;
    lockfileError: {
        path: Text;
        reason: 'not-found' | 'not-resolved';
        pathBasis: 'error-message' | 'action-input';
    };
    saveOutcome: SaveOutcome;
    saveReason: {
        class: 'normal-policy' | 'failure' | 'unknown';
        code: Text;
    };
    cacheHit: CacheHit;
    keyLayout: KeyLayout;
    cacheEnabled: boolean;
    packageManager: 'npm' | 'yarn' | 'pnpm';
    cacheVersion: Text;
}
export type Field = keyof FieldValues;
export type EvidenceOrigin = 'log' | 'workflow' | 'user_provided' | 'cache_list';
export type Observation = {
    [F in Field]: {
        id: Id;
        runId: RunId;
        stepRef?: Id;
        blockId?: Id;
        field: F;
        value: Presence<FieldValues[F]>;
        status: Certainty;
        refs: SourceRef[];
        origin: EvidenceOrigin;
        patternId?: Id;
        verification: 'verified' | 'user_declared' | 'unverified';
    };
}[Field];
export interface BlockCompleteness {
    state: 'complete' | 'incomplete' | 'unknown' | 'conflict';
    basis: 'runner-boundaries' | 'user_provided' | 'none';
    refs: SourceRef[];
}
export interface LogBlock {
    id: Id;
    runId: RunId;
    range: SourceRef;
    phase: 'main' | 'post' | 'save' | 'unknown';
    actionKind: Presence<ActionKind>;
    actionRef: Presence<Text>;
    jobId: Presence<Text>;
    stepId: Presence<Text>;
    stepIndex: Presence<number>;
    parentCandidates: Id[];
    completeness: BlockCompleteness;
    observationIds: Id[];
    profileEntryIds: Id[];
    verification: 'verified' | 'user_declared' | 'unverified';
}
export interface ParsedRun {
    runId: RunId;
    sourceId: Id;
    blocks: LogBlock[];
    observations: Observation[];
    diagnostics: Diagnostic[];
}
export type StepTarget = {
    stepRef: Id;
} | {
    jobId: Text;
    stepIndex: number;
} | {
    jobId: Text;
    stepId: Text;
};
export interface LineRange {
    startLine: number;
    endLine: number;
}
export interface ContextRegion {
    id: Id;
    phase: 'main' | 'post' | 'save';
    range: SourceRef;
    declarationRef: SourceRef;
    parentRegionId?: Id;
    completeness: BlockCompleteness;
}
export interface ContextStep {
    id: Id;
    runId: RunId;
    target: StepTarget;
    refs: SourceRef[];
    regions: ContextRegion[];
    evidence: Observation[];
    saveTargets: {
        target: StepTarget;
        refs: SourceRef[];
    }[];
}
export interface ListScope {
    repository: Presence<Text>;
    ref: Presence<Text>;
    observedAt: Presence<Text>;
}
export interface Pagination {
    state: 'complete' | 'incomplete' | 'unknown' | 'conflict';
    allPages: Presence<boolean>;
    expectedCount: Presence<number>;
    importedCount: number;
    refs: SourceRef[];
    origin: 'user_provided' | 'cache_list';
}
export interface Context {
    sourceId: Id;
    steps: ContextStep[];
    cacheList?: {
        pagination: Pagination;
        scope: ListScope;
        refs: SourceRef[];
    };
    diagnostics: Diagnostic[];
}
export interface CacheEntry {
    id: Id;
    providerId: Presence<Text>;
    key: Presence<Text>;
    version: Presence<Text>;
    ref: Presence<Text>;
    sizeBytes: Presence<number>;
    createdAt: Presence<Text>;
    lastAccessedAt: Presence<Text>;
    fieldRefs: {
        field: 'providerId' | 'key' | 'version' | 'ref' | 'sizeBytes' | 'createdAt' | 'lastAccessedAt';
        refs: SourceRef[];
    }[];
}
export interface CacheList {
    sourceId: Id;
    format: 'rest' | 'gh';
    entries: CacheEntry[];
    totalCount: Presence<number>;
    pagination: Pagination;
    scope: ListScope;
    diagnostics: Diagnostic[];
}
export interface Selection {
    jobId?: Text;
    step?: {
        kind: 'stepRef' | 'stepId';
        value: Text;
    };
}
export interface RunCandidate {
    id: Id;
    stepRef: Id;
    runId: RunId;
    mainBlockId: Id;
    postBlockIds: Id[];
    saveStepRefs: Id[];
    saveBlockIds: Id[];
    basis: 'runner-identity' | 'context-range';
    refs: SourceRef[];
    mainStatus: 'unique' | 'ambiguous' | 'conflict';
    saveStatus: 'unique' | 'missing' | 'ambiguous' | 'conflict';
    status: 'unique' | 'ambiguous' | 'conflict';
    missingEvidence: MissingEvidence[];
}
export interface StepAssociation {
    stepRef: Id;
    inScope: boolean;
    runA: RunCandidate[];
    runB: RunCandidate[];
    status: 'unique' | 'missing' | 'ambiguous' | 'conflict';
    selected?: {
        runACandidateId: Id;
        runBCandidateId: Id;
    };
    missingEvidence: MissingEvidence[];
}
export interface AssociationResult {
    selection: Selection;
    selectedSteps: Id[];
    steps: StepAssociation[];
    diagnostics: Diagnostic[];
}
export interface ComparisonSide {
    runId: RunId;
    observationIds: Id[];
    values: Observation[];
    basis: 'actual' | 'user_provided' | 'mixed' | 'missing';
}
export interface Comparison {
    id: Id;
    stepRef: Id;
    field: 'primaryKey' | 'restoreKeys' | 'runnerOS' | 'resolvedPaths' | 'ref';
    a: ComparisonSide;
    b: ComparisonSide;
    state: 'same' | 'different' | 'unknown' | 'conflict';
    evidenceRefs: SourceRef[];
    differences: {
        aStart: number;
        aEnd: number;
        bStart: number;
        bEnd: number;
    }[];
    missingEvidence: MissingEvidence[];
}
export interface Finding {
    id: Id;
    stepRef: Id;
    code: string;
    kind: 'fact' | 'problem' | 'pending';
    certainty: Certainty;
    evidenceRefs: SourceRef[];
    observationIds: Id[];
    missingEvidence: MissingEvidence[];
    message: Message;
    suggestionId?: Id;
}
export interface Suggestion {
    id: Id;
    findingIds: Id[];
    title: Message;
    yaml: Text;
    placeholders: {
        name: string;
        required: true;
        explanation: Message;
    }[];
    evidenceRefs: SourceRef[];
}
export interface AnalysisInputs {
    sources: Source[];
    excerpts: EvidenceExcerpt[];
    workflow: ParsedWorkflow;
    runs: [
        ParsedRun,
        ParsedRun
    ];
    context?: Context;
    cacheList?: CacheList;
    profile: Compatibility;
    diagnostics: Diagnostic[];
}
export interface StepView {
    stepRef: Id;
    association: StepAssociation;
    comparisonIds: Id[];
    findingIds: Id[];
    diagnosticIds: Id[];
}
export interface BaseReport {
    schemaVersion: 1;
    profile: Compatibility;
    sources: Source[];
    excerpts: EvidenceExcerpt[];
    selectedSteps: Id[];
    associations: AssociationResult;
    observations: Observation[];
    cacheList?: CacheList;
    steps: WorkflowStep[];
    stepViews: StepView[];
    comparisons: Comparison[];
    findings: Omit<Finding, 'suggestionId'>[];
    diagnostics: Diagnostic[];
}
export interface Report extends Omit<BaseReport, 'findings'> {
    findings: Finding[];
    suggestions: Suggestion[];
}
export interface CodeSource {
    id: Id;
    repository: 'actions/cache' | 'actions/setup-node' | 'actions/runner';
    commit: string;
    path: string;
    url: string;
    startLine: number;
    endLine: number;
    statement: Text;
    contentSha256: string;
}
export interface LogPattern {
    id: Id;
    sourceId: Id;
    actionKinds: ActionKind[];
    phase: 'main' | 'post' | 'save';
    role: 'observation' | 'block-open' | 'block-close' | 'parent-link' | 'execution-commit' | 'input-component';
    segments: ({
        literal: Text;
    } | {
        capture: string;
        codec: 'text' | 'key' | 'boolean' | 'sha40' | 'path-list' | 'save-outcome';
        separator?: Text;
    })[];
    outputs: {
        field: Field | 'jobId' | 'stepId' | 'stepIndex' | 'parentId' | 'dependencyPathInput';
        from: {
            kind: 'capture';
            name: string;
        } | {
            kind: 'constant';
            value: Text | boolean | number | {
                class: 'normal-policy' | 'failure' | 'unknown';
                code: Text;
            };
        } | {
            kind: 'decoder';
            id: Id;
            captures: string[];
            components?: {
                field: 'dependencyPathInput';
                patternIds: Id[];
                scope: 'same-block';
                cardinality: 'one';
            }[];
        };
    }[];
    acceptedPrefixes: ('none' | 'iso8601-space' | 'runner-group')[];
    multiline: false;
    anchor: 'whole-line';
    coverage: Text;
    fixtureIds: string[];
}
export interface CompatibilityEntry {
    id: Id;
    actionKind: ActionKind;
    actionName: 'actions/cache' | 'actions/cache/restore' | 'actions/cache/save' | 'actions/setup-node';
    declaredRefs: string[];
    sourceCommit: string;
    sourceIds: Id[];
    patternIds: Id[];
    limitations: Text[];
}
export interface Compatibility {
    schemaVersion: 1;
    id: Id;
    codeSources: CodeSource[];
    entries: CompatibilityEntry[];
    patterns: LogPattern[];
}

# Context / 上下文格式

Context records explicit user declarations. Regions use original, one-based, inclusive physical log lines. `stepIndex` is zero-based across the entire workflow steps array, including non-cache steps. 用户声明始终保留 `user_provided` 来源；日志语句独立解析，不由声明生成。

```json
{
  "schemaVersion": 1,
  "runs": {
    "a": {
      "steps": [{
        "target": {"jobId": "build", "stepIndex": 0},
        "regions": [{"id": "main", "phase": "main", "startLine": 2, "endLine": 6}],
        "evidence": [{"field": "primaryKey", "state": "value", "value": "example-key"}]
      }]
    },
    "b": {"steps": []}
  }
}
```

Use this only when the named job/step and ranges match your actual inputs. Replace them with your own mapping. Targets can also be `{ "jobId": "build", "stepId": "cache" }` or `{ "stepRef": "FULL_STABLE_STEP_REF_FROM_REPORT" }`. `complete:true` is a user assertion; it does not create independently verified runner completeness. `parentRegionId` links a post region to its main region. `saveTargets` can declare an explicit restore-to-save step relationship.

只有实际存在的 job/step 和有效行范围才可引用。`complete:true` 只表示用户声明，不能升级成 runner 独立完备证据。`parentRegionId` 用于连接 post 与 main；`saveTargets` 可声明明确的 restore/save 步骤关系。

The authoritative field shapes are in `src/model.ts`. The complete, inspectable [dynamic-key example](../fixtures/dynamic-key/context.json) includes declared key/layout/hash/OS/path/ref fields and a separate runner-download `logRanges` declaration. The [lockfile example](../fixtures/lockfile-path/context.json) works with a same-block action input header. JSON `refs`, origins, run IDs, verification or trusted identities supplied by a caller are never accepted as provenance. `resolvedKey` is rejected; use `primaryKey`.

For cache-list pagination, optional `cacheList` has `allPages`, `expectedCount`, and `scope` (`repository`, `ref`, `observedAt`). A complete list requires consistent counts, complete scope and an explicit all-pages declaration. The declaration retains its user-provided evidence level. REST input maps `size_in_bytes`, `created_at`, `last_accessed_at`; `gh` arrays map `sizeInBytes`, `createdAt`, `lastAccessedAt`.

Never paste private credentials into examples or issue reports. Use synthetic inputs with the same structure. 示例和问题报告请使用结构相同的合成材料。

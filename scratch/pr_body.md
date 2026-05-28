## 关联

Closes #97

## 改动点

- 扩展 `processNextRecordingValidationJob()` (在 `apps/api/src/cloud/validationWorker.ts` 中) 支持 P1 初始包预算检查，包括：
  - `durationMs <= 15 * 60 * 1000` (15 分钟)
  - `eventCount <= 20000`
  - `media.sizeBytes <= 200MB`
  - `totalAssetSizeBytes <= 250MB`
- 在 `validationWorker.ts` 中实现可选资产 (indexes, thumbnail, media) 缺失时不阻断 ready。当 media 缺失时，自动更新 recording metadata 将 `hasAudio` 和 `hasCamera` 置为 `false` 以标记为无媒体云端录制。
- 在 `validateCreateUploadSessionInput` (在 `apps/api/src/cloud/cloudRecordingService.ts` 中) 同样对 `durationMs`、`media.sizeBytes` 和 `totalAssetSizeBytes` 校验，超出限制时同样返回 `quota-exceeded` 错误。
- 补齐全面的单元与集成测试覆盖上述所有预算校验及可选资产降级行为。

## 影响范围

- 云端 validation worker 及录制会话创建 API。

## GitNexus 影响分析摘要

- 风险等级: LOW
- 关键骨架变更: 无
- GitNexus 影响面: 通过 detect_changes 确认没有影响 critical contract，已分析 context。
- 验证结果: 所有 56 个 API 测试及 49 个单元测试均本地通过，Playwright E2E 完整通过。

## 自检

- [x] 未修改 `docs/progress.json` 或 `docs/progress.md`
- [x] 已运行 `npm run quality:local`，或说明无法运行的原因
- [x] 已说明改动点和影响范围
- [x] 如果改动关键骨架，已补充契约测试并填写 GitNexus 影响分析摘要
- [x] 已邀请至少一名非作者同学 CR

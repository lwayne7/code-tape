1. docs/PRD/代码讲解工具.md 文档的权威性是最高的
2. 提交的代码不准背离 docs/技术方案.md 。若认为技术方案有任何错误，应通过 discussion 及时上报仓库维护者
3. 在提交 PR 后等待 GitHub Actions 运行、repo-guard 评论后进行审查
4. 使用 karpathy-guidelines 技能确保代码改动的高质量、精确性
5. 前端 UI 设计使用 frontend-design 技能
6. 任意 agent 在改代码前必须先运行 `npm run agent:bootstrap`
7. 每次开始任务前必须运行 `npm run quality:predev`；提交或推送前必须运行 `npm run quality:local`。两者不是二选一：`quality:predev` 只安装 hooks 并刷新 GitNexus 索引，`quality:local` 会刷新索引并运行完整本地质量闸门
8. 如果改动触碰 schema、runtime、repository、replay、workflow 或权威文档等关键骨架，必须阅读 GitNexus 的 `detect_changes` / `query` / `context` / `impact` 建议，并在 PR 中填写 GitNexus 影响分析摘要

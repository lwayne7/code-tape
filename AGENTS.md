# 文档
1. docs/PRD.md 文档的权威性是最高的
2. 提交的代码不准背离 docs/技术方案.md 。若认为技术方案有任何错误，应通过 discussion 及时上报仓库维护者

# 工作
1. 每次开始任务前必须运行 `npm run quality:predev`
2. 在改代码前必须先运行 `npm run agent:bootstrap`
3. 创建分支以 feature/ , fix/ 或 chore/ 开头
4. 使用 Karpathy Guidelines 技能确保代码改动的高质量、精确性
5. 前端 UI 设计使用 frontend-design 技能
6. 启动本地 web dev server 必须用 `npm run dev`
7. 在改动后必须阅读 GitNexus 的建议
8. 发起 PR ，然后等待 GitHub Actions 运行（不用理会“需要CR通过”的错误，这是正常的）、repo-guard 和 Copilot 的评论后进行审查

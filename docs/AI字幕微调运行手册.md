# AI 字幕后处理模型微调运行手册

本手册把 `docs/技术方案.md` 中的 P1+ AI 字幕微调路线落成可执行链路。目标模型只做 ASR 后处理：输入原始字幕、前端代码上下文、运行输出和术语表，输出严格 JSON，用于字幕纠错和章节跳转点生成。

## 安全边界

- 不把 Hugging Face Token、teacher API Key 或任何密钥写入仓库、前端代码、测试 fixture、PR 描述或命令示例。
- 浏览器本地推理只拉取公开 Hugging Face 模型资产，不携带 token。
- 蒸馏与发布只在本机 shell、Colab Secrets 或 CI Secret 中读取 `TEACHER_API_KEY` / `HF_TOKEN`。
- 已经粘贴到聊天里的 token 应在对应平台轮换后再用于正式训练。

## 蒸馏语料可以怎么做

可以，用蒸馏是当前最推荐的起步方式：

1. 准备 seed 样本：原始 ASR 字幕、代码上下文、运行输出、前端术语表。
2. 调用 teacher 模型：让 `gpt-5.5` 按 code-tape 输出契约生成修正字幕和章节 JSON。
3. 校验 teacher 输出：必须包含每个输入 segment，必须包含 `chapters` 数组，不能包含密钥形态文本。
4. 生成 SFT JSONL：保存为三轮 chat record，供 LoRA / SFT 训练 student 模型。
5. 训练 student：使用小型 instruct 模型做 LoRA，评估 JSON 合法率、术语准确率、简体中文一致性、中英混合保真率和章节边界误差。
6. 发布公开模型：将 adapter 或合并后的模型发布到 Hugging Face，再导出 Transformers.js 兼容 ONNX。

## 本地命令

先注入密钥到当前 shell。不要写入 `.env`、文档或脚本：

```bash
export TEACHER_API_URL="https://saturday.sankuai.com"
export TEACHER_MODEL="gpt-5.5"
export TEACHER_API_KEY="<paste locally>"
export HF_TOKEN="<paste locally>"
```

校验 seed 样本：

```bash
npm run subtitle:dataset:validate
```

调用 teacher 生成蒸馏训练集：

```bash
npm run subtitle:distill
```

## 训练平台建议

推荐先用 Colab GPU 做 LoRA 训练，本地机器只做 seed 校验、蒸馏脚本调试和小样本 smoke test。原因是浏览器目标模型虽小，但 `Qwen/Qwen2.5-0.5B-Instruct` 训练仍需要稳定 GPU 显存；Colab Secrets 可以分别保存 `TEACHER_API_KEY` 和 `HF_TOKEN`，不会进入 notebook 输出。若后续样本量扩大，再迁移到 Hugging Face AutoTrain、团队 GPU 机器或 CI 外部训练任务。

创建 Python 环境并安装训练依赖：

```bash
python3 -m venv .venv-subtitle-llm
. .venv-subtitle-llm/bin/activate
pip install -r ml/subtitle-postprocessor/requirements.txt
```

启动 LoRA 微调：

```bash
python3 ml/subtitle-postprocessor/train_lora.py \
  --train-jsonl ml/subtitle-postprocessor/data/generated/distilled.jsonl \
  --base-model Qwen/Qwen2.5-0.5B-Instruct \
  --output-dir ml/subtitle-postprocessor/output/lora \
  --hub-model-id ceilf6/code-tape-subtitle-postprocessor-lora
```

训练脚本默认不信任远端模型仓库代码。只有确认 base model 需要自定义 Python 代码且来源可信时，才可以添加 `--trust-remote-code`；该模式不能与 `--hub-model-id` 同时使用，避免远端模型加载阶段接触发布 token。需要 remote code 的特殊模型应先只输出本地 adapter，再用可信发布流程单独上传。

## 发布到浏览器本地推理

训练完成后还需要执行模型合并、ONNX 导出和量化。优先目标是发布公开仓库：

- `ceilf6/code-tape-subtitle-postprocessor-onnx`

前端接入时只改公开模型 ID，不传任何 token。若 ONNX Runtime Web 遇到量化权重缺少 scale 等兼容问题，应回退到未融合或重新导出的权重，不能在前端吞异常后展示“已纠错”。

## 验收标准

- `npm run subtitle:dataset:validate` 通过。
- 蒸馏输出中每条 record 的 assistant JSON 都包含 `segments` 和 `chapters`。
- 训练评估至少覆盖：
  - JSON 合法率。
  - 每个输入 segment exactly once。
  - React / TypeScript / code-tape 术语保持。
  - 中文输出为简体中文。
  - 中文一句、英文一句的字幕保持自然混合。
  - 章节按时间递增且不重叠。

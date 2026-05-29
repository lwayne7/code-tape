# AI 字幕后处理模型微调运行手册

本手册记录 P1+ AI 字幕微调链路。当前产品默认使用公开微调模型 `ceilf6/code-tape-subtitle-postprocessor-onnx` 做浏览器本地 ASR 后处理：输入原始字幕、前端代码上下文、运行输出和术语表，输出严格 JSON，用于字幕纠错和章节跳转点生成。

## 安全边界

- 不把 Hugging Face Token、teacher API Key 或任何密钥写入仓库、前端代码、测试 fixture、PR 描述或命令示例。
- 浏览器本地推理只拉取公开 Hugging Face 模型资产，不携带 token。
- 蒸馏与发布只在本机 shell、Colab Secrets 或 CI Secret 中读取 `TEACHER_API_KEY` / `HF_TOKEN`。
- 已经粘贴到聊天里的 token 应在对应平台轮换后再用于正式训练。

## 蒸馏语料可以怎么做

可以，用蒸馏是当前最推荐的起步方式：

1. 准备 seed 样本：原始 ASR 字幕、代码上下文、运行输出、前端术语表。
2. 调用 teacher 模型：让 `gpt-5.5` 按 code-tape 输出契约生成修正字幕和章节 JSON。
3. 校验 teacher 输出：`segments` 可以只包含需要修改的字幕段，但不能包含未知或重复 segment id；必须包含非空 `chapters` 数组，不能包含密钥形态文本。
4. 生成 SFT JSONL：保存为三轮 chat record，供 LoRA / SFT 训练 student 模型。
5. 训练 student：使用小型 instruct 模型做 LoRA，评估 JSON 合法率、术语准确率、稀疏 segment 合法性和章节边界误差。
6. 发布公开模型：将 adapter 或合并后的模型发布到 Hugging Face，再导出 Transformers.js 兼容 ONNX。

seed 样本和 distilled SFT 样本不能只覆盖少数 happy path。当前仓库用测试约束两类 corpus 都至少 200 条，并要求覆盖 React、TypeScript、Vite、Playwright、Vitest、Web Worker、WebGPU/WASM、IndexedDB、repo-guard、SubtitlePanel 和章节生成等 code-tape 场景，避免小模型只学到固定样例格式。

为了降低浏览器本地推理等待，语料默认教模型输出稀疏 `segments`：只有需要修改的字幕段才进入 assistant JSON，未返回的字幕段由应用层保留原文。`npm run subtitle:evaluate` 会阻止训练集回到“每个 segment 全量重写”的模式，当前硬门槛是 `sparseOutputRate >= 0.85`、`fullSegmentOutputRate <= 0.15`、`averageOutputSegmentRatio <= 0.3`、`longTrackRecordRate >= 0.75`。

训练 prompt 侧的原始字幕字段使用 `inputSegments`，assistant 输出字段才使用 `segments`。不要把输入和输出都命名为 `segments`，否则小模型容易复制输入里的 `startMs/endMs/text` schema，导致浏览器端出现缺少 `text`、未知字段或 JSON 截断。

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

如后续继续做项目专属 LoRA，推荐先用 Colab GPU 做训练，本地机器做 seed 校验、蒸馏脚本调试、小样本 smoke test 和模型合并验证。实验 base model 可以继续使用 `HuggingFaceTB/SmolLM2-135M-Instruct`，浏览器默认使用导出的公开 ONNX 仓库；Colab Secrets 可以分别保存 `TEACHER_API_KEY` 和 `HF_TOKEN`，不会进入 notebook 输出。若后续样本量扩大，再迁移到 Hugging Face AutoTrain、团队 GPU 机器或 CI 外部训练任务。

创建 Python 环境并安装训练依赖：

```bash
python3.10 -m venv .venv-subtitle-llm
. .venv-subtitle-llm/bin/activate
pip install -r ml/subtitle-postprocessor/requirements.txt
```

启动 LoRA 微调：

```bash
python3 ml/subtitle-postprocessor/train_lora.py \
  --train-jsonl ml/subtitle-postprocessor/data/generated/distilled.jsonl \
  --base-model HuggingFaceTB/SmolLM2-135M-Instruct \
  --output-dir ml/subtitle-postprocessor/output/lora \
  --hub-model-id ceilf6/code-tape-subtitle-postprocessor-lora
```

训练前后评估蒸馏语料：

```bash
npm run subtitle:evaluate
```

训练脚本默认不信任远端模型仓库代码。只有确认 base model 需要自定义 Python 代码且来源可信时，才可以添加 `--trust-remote-code`；该模式不能与 `--hub-model-id` 同时使用，避免远端模型加载阶段接触发布 token。需要 remote code 的特殊模型应先只输出本地 adapter，再用可信发布流程单独上传。

## 发布到浏览器本地推理

当前浏览器端默认使用公开微调 ONNX 仓库：

- `ceilf6/code-tape-subtitle-postprocessor-onnx`

前端接入时只改公开模型 ID，不传任何 token。v12 默认只发布并加载通过本地 Transformers.js smoke test 的 WASM `q8` ONNX 资产；`q4f16` / `q4` 产物在输出稳定性通过同等 smoke test 前不得放回默认加载优先级。若 ONNX Runtime Web 遇到量化权重缺少 scale 等兼容问题，应保留原始 ASR 字幕，不能在前端吞异常后展示“已纠错”。

合并 LoRA adapter 后发布完整模型：

```bash
python3 ml/subtitle-postprocessor/merge_lora.py \
  --base-model HuggingFaceTB/SmolLM2-135M-Instruct \
  --adapter-dir ml/subtitle-postprocessor/output/lora \
  --output-dir ml/subtitle-postprocessor/output/merged \
  --hub-model-id ceilf6/code-tape-subtitle-postprocessor-merged
```

合并脚本会优先尝试 adapter 目录中的 tokenizer；adapter-only 目录没有 tokenizer 文件时，自动回退到 `--base-model` 的 tokenizer。

需要临时验证其他模型时，可以用环境变量覆盖：

```bash
VITE_SUBTITLE_POSTPROCESSOR_MODEL=onnx-community/Qwen2.5-0.5B-Instruct npm run dev
```

## 验收标准

- `npm run subtitle:dataset:validate` 通过。
- 蒸馏输出中每条 record 的 assistant JSON 都包含 `segments` 和非空 `chapters`。
- 训练评估至少覆盖：
  - JSON 合法率。
  - `segments` 稀疏输出不包含未知或重复 id，未返回字幕段能保留原文。
  - React / TypeScript / code-tape 术语保持。
  - 章节按时间递增且不重叠。

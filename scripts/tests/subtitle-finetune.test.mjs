import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildTrainingRecord,
  buildDistillationMessages,
  validateSubtitleDistillationExample,
  validateSubtitleTrainingRecord,
  validateSubtitleTeacherResult,
} from '../subtitle-llm/schema.mjs';

const seedExample = {
  id: 'react-state-hook-001',
  language: 'zh-CN',
  context: {
    fileName: 'Counter.tsx',
    code: 'const [count, setCount] = useState(0);',
    runtimeOutput: 'ReferenceError: count is not defined',
    glossary: ['React', 'useState', 'setCount', 'code-tape'],
  },
  segments: [
    { id: 'subtitle-1', startMs: 0, endMs: 1200, text: '这里用 use state 维护 count' },
    { id: 'subtitle-2', startMs: 1200, endMs: 2600, text: '然后 set count 触发 render' },
  ],
};

const teacherResult = {
  segments: [
    { id: 'subtitle-1', text: '这里用 useState 维护 count' },
    { id: 'subtitle-2', text: '然后 setCount 触发 render' },
  ],
  chapters: [{ title: '状态设计', startMs: 0, endMs: 2600 }],
};

test('validates subtitle distillation examples for correction and chapter generation', () => {
  assert.deepEqual(validateSubtitleDistillationExample(seedExample), seedExample);
  assert.deepEqual(validateSubtitleTeacherResult(teacherResult, seedExample), teacherResult);
});

test('accepts sparse teacher subtitle corrections for unchanged segments', () => {
  assert.deepEqual(
    validateSubtitleTeacherResult(
      {
        segments: [{ id: 'subtitle-2', text: '然后 setCount 触发 render' }],
        chapters: teacherResult.chapters,
      },
      seedExample,
    ),
    {
      segments: [{ id: 'subtitle-2', text: '然后 setCount 触发 render' }],
      chapters: teacherResult.chapters,
    },
  );
});

test('rejects distillation samples that omit chapters', () => {
  assert.throws(
    () => validateSubtitleTeacherResult({ segments: teacherResult.segments }, seedExample),
    /chapters/,
  );
});

test('rejects distillation samples without chapter training signal', () => {
  assert.throws(
    () =>
      validateSubtitleTeacherResult(
        {
          segments: teacherResult.segments,
          chapters: [],
        },
        seedExample,
      ),
    /chapters must contain at least one chapter/,
  );
});

test('rejects duplicate input subtitle segment ids before distillation', () => {
  assert.throws(
    () =>
      validateSubtitleDistillationExample({
        ...seedExample,
        segments: [
          seedExample.segments[0],
          {
            ...seedExample.segments[1],
            id: seedExample.segments[0].id,
          },
        ],
      }),
    /duplicate segment id/,
  );
});

test('rejects overlapping or unsorted input subtitle segments before distillation', () => {
  assert.throws(
    () =>
      validateSubtitleDistillationExample({
        ...seedExample,
        segments: [
          seedExample.segments[0],
          {
            ...seedExample.segments[1],
            startMs: 1000,
            endMs: 2000,
          },
        ],
      }),
    /segments must be ordered and non-overlapping/,
  );
});

test('rejects malformed assistant training JSON contracts', () => {
  const record = buildTrainingRecord({
    example: seedExample,
    teacherResult,
    teacherModel: 'gpt-5.5',
  });

  assert.throws(
    () =>
      validateSubtitleTrainingRecord({
        ...record,
        messages: [
          record.messages[0],
          record.messages[1],
          {
            role: 'assistant',
            content: JSON.stringify({ segments: 'bad shape', chapters: [] }),
          },
        ],
      }),
    /teacher result segments are required/,
  );
});

test('rejects generated chapters outside the source subtitle timeline', () => {
  assert.throws(
    () =>
      validateSubtitleTeacherResult(
        {
          segments: teacherResult.segments,
          chapters: [{ title: '越界章节', startMs: 2600, endMs: 3200 }],
        },
        seedExample,
      ),
    /chapters must stay within the source subtitle timeline/,
  );
});

test('rejects overlapping or unsorted generated chapters', () => {
  assert.throws(
    () =>
      validateSubtitleTeacherResult(
        {
          segments: teacherResult.segments,
          chapters: [
            { title: '实现', startMs: 1000, endMs: 2200 },
            { title: '分析', startMs: 1500, endMs: 2600 },
          ],
        },
        seedExample,
      ),
    /chapters must be ordered and non-overlapping/,
  );
});

test('rejects unknown or duplicate subtitle segment ids in teacher output', () => {
  assert.throws(
    () =>
      validateSubtitleTeacherResult(
        {
          segments: [{ id: 'subtitle-404', text: 'bad segment' }],
          chapters: teacherResult.chapters,
        },
        seedExample,
      ),
    /unknown segment/,
  );
  assert.throws(
    () =>
      validateSubtitleTeacherResult(
        {
          segments: [
            { id: 'subtitle-1', text: 'first correction' },
            { id: 'subtitle-1', text: 'second correction' },
          ],
          chapters: teacherResult.chapters,
        },
        seedExample,
      ),
    /repeats segment/,
  );
});

test('rejects secrets in distillation inputs and outputs', () => {
  const fakeHfToken = `${'h'}${'f'}_${'a'.repeat(30)}`;
  const fakeApiKey = `${'s'}${'k'}-${'b'.repeat(30)}`;
  assert.throws(
    () =>
      validateSubtitleDistillationExample({
        ...seedExample,
        context: {
          ...seedExample.context,
          runtimeOutput: `never store ${fakeHfToken} in fixtures`,
        },
      }),
    /secret-like value/,
  );
  assert.throws(
    () =>
      validateSubtitleTeacherResult(
        {
          segments: [{ id: 'subtitle-1', text: `contains ${fakeApiKey}` }],
          chapters: [],
        },
        { ...seedExample, segments: [seedExample.segments[0]] },
      ),
    /secret-like value/,
  );
});

test('builds deterministic teacher distillation messages without secrets', () => {
  const messages = buildDistillationMessages(seedExample);

  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /只输出 JSON/);
  assert.match(messages[0].content, /Goal: correct ASR subtitle text/u);
  assert.match(messages[1].content, /Counter\.tsx/);
  assert.match(messages[1].content, /subtitle-1/);
  assert.doesNotMatch(messages[1].content, /"language"/u);
  assert.doesNotMatch(JSON.stringify(messages), new RegExp(`${'h'}${'f'}_|${'s'}${'k'}-`, 'u'));
});

test('builds SFT records with an assistant JSON contract', () => {
  const record = buildTrainingRecord({
    example: seedExample,
    teacherResult,
    teacherModel: 'gpt-5.5',
  });

  assert.deepEqual(validateSubtitleTrainingRecord(record), record);
  assert.equal(record.messages[2].role, 'assistant');
  assert.match(record.messages[2].content, /"chapters"/);
  assert.deepEqual(record.metadata.inputSegmentIds, ['subtitle-1', 'subtitle-2']);
});

test('LoRA training parser does not trust remote code unless explicitly requested', () => {
  const python = [
    'import importlib.util',
    'spec = importlib.util.spec_from_file_location("train_lora", "ml/subtitle-postprocessor/train_lora.py")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'parser = module.build_parser()',
    'default_args = parser.parse_args(["--train-jsonl", "train.jsonl"])',
    'opt_in_args = parser.parse_args(["--train-jsonl", "train.jsonl", "--trust-remote-code"])',
    'print(f"{default_args.trust_remote_code},{opt_in_args.trust_remote_code}")',
  ].join('; ');
  const result = spawnSync('python3', ['-c', python], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'False,True');
});

test('LoRA training defaults to the browser-targeted SmolLM2 base model', () => {
  const python = [
    'import importlib.util',
    'spec = importlib.util.spec_from_file_location("train_lora", "ml/subtitle-postprocessor/train_lora.py")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'parser = module.build_parser()',
    'args = parser.parse_args(["--train-jsonl", "train.jsonl"])',
    'print(args.base_model)',
  ].join('; ');
  const result = spawnSync('python3', ['-c', python], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'HuggingFaceTB/SmolLM2-135M-Instruct');
});

test('LoRA training masks loss to assistant JSON tokens', () => {
  const python = [
    'import importlib.util',
    'spec = importlib.util.spec_from_file_location("train_lora", "ml/subtitle-postprocessor/train_lora.py")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'print("{% generation %}" in module.ASSISTANT_MASK_CHAT_TEMPLATE)',
  ].join('; ');
  const result = spawnSync('python3', ['-c', python], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'True');
});

test('evaluates subtitle SFT records for JSON, chapter, and glossary quality', () => {
  const result = spawnSync(
    'node',
    ['scripts/subtitle-llm/evaluate-corpus.mjs', 'scripts/tests/fixtures/valid-subtitle-train.jsonl'],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const metrics = JSON.parse(result.stdout);
  assert.equal(metrics.records, 1);
  assert.equal(metrics.invalidRecords, 0);
  assert.equal(metrics.jsonValidRate, 1);
  assert.equal(metrics.chapterSignalRate, 1);
  assert.equal(metrics.glossaryPreservationRate, 1);
  assert.equal(Object.hasOwn(metrics, 'simplifiedChineseRate'), false);
});

test('subtitle corpus evaluation does not treat language style as a blocking metric', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'subtitle-language-neutral-eval-'));
  const fixturePath = join(tempDir, 'train.jsonl');
  const record = buildTrainingRecord({
    example: {
      ...seedExample,
      segments: [
        { id: 'subtitle-1', startMs: 0, endMs: 1200, text: '这里检查状态和输出' },
      ],
    },
    teacherResult: {
      segments: [{ id: 'subtitle-1', text: '这里检查状态和输出' }],
      chapters: [{ title: '状态检查', startMs: 0, endMs: 1200 }],
    },
    teacherModel: 'gpt-5.5',
  });

  try {
    writeFileSync(fixturePath, `${JSON.stringify(record)}\n`);
    const result = spawnSync('node', ['scripts/subtitle-llm/evaluate-corpus.mjs', fixturePath], {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const metrics = JSON.parse(result.stdout);
    assert.equal(metrics.jsonValidRate, 1);
    assert.equal(Object.hasOwn(metrics, 'simplifiedChineseRate'), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('LoRA merge falls back to the base model tokenizer for adapter-only directories', () => {
  const python = [
    'import importlib.util',
    'spec = importlib.util.spec_from_file_location("merge_lora", "ml/subtitle-postprocessor/merge_lora.py")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'class FakeTokenizer:',
    '    calls = []',
    '    @classmethod',
    '    def from_pretrained(cls, source, trust_remote_code=False):',
    '        cls.calls.append((source, trust_remote_code))',
    '        if source == "adapter-only":',
    '            raise OSError("missing tokenizer")',
    '        return {"source": source, "trust": trust_remote_code}',
    'tokenizer = module.load_tokenizer(FakeTokenizer, "adapter-only", "base-model", True)',
    'print(tokenizer["source"])',
    'print(FakeTokenizer.calls)',
  ].join('\n');
  const result = spawnSync('python3', ['-c', python], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /base-model/);
  assert.match(result.stdout, /\('adapter-only', True\).*'base-model'/s);
});

test('LoRA training script rejects remote code trust with hub publishing', () => {
  const fakeHfToken = `${'h'}${'f'}_${'c'.repeat(30)}`;
  const result = spawnSync(
    'python3',
    [
      'ml/subtitle-postprocessor/train_lora.py',
      '--train-jsonl',
      'train.jsonl',
      '--trust-remote-code',
      '--hub-model-id',
      'ceilf6/test-model',
    ],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
      env: { ...process.env, HF_TOKEN: fakeHfToken },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Do not combine --trust-remote-code with --hub-model-id/);
});

test('LoRA training script validates JSONL messages before loading ML dependencies', () => {
  const result = runTrainingValidation('scripts/tests/fixtures/malformed-subtitle-train.jsonl');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must contain a messages list/);
});

test('LoRA training script rejects records without strict subtitle SFT turns', () => {
  const result = runTrainingValidation('scripts/tests/fixtures/bad-role-subtitle-train.jsonl');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /messages\[0\]\.role must be system/);
});

test('LoRA training script rejects assistant content that is not JSON', () => {
  const result = runTrainingValidation('scripts/tests/fixtures/non-json-assistant-subtitle-train.jsonl');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /assistant content is not valid JSON/);
});

test('LoRA training script rejects subtitle records without required chapters', () => {
  const result = runTrainingValidation('scripts/tests/fixtures/missing-chapters-subtitle-train.jsonl');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /assistant JSON must contain segments and chapters arrays/);
});

test('LoRA training script rejects subtitle records with empty chapters', () => {
  const result = runTrainingValidation('scripts/tests/fixtures/empty-chapters-subtitle-train.jsonl');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /chapters must contain at least one chapter/);
});

test('LoRA training script rejects secret-like training records before loading ML dependencies', () => {
  const fakeHfToken = `${'h'}${'f'}_${'d'.repeat(30)}`;
  const tempDir = mkdtempSync(join(tmpdir(), 'subtitle-secret-train-'));
  const fixturePath = join(tempDir, 'secret-train.jsonl');
  const record = {
    messages: [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: JSON.stringify({
          context: { runtimeOutput: `never train ${fakeHfToken}` },
          segments: [{ id: 'subtitle-1', startMs: 0, endMs: 1200, text: '原始字幕' }],
        }),
      },
      {
        role: 'assistant',
        content: JSON.stringify({
          segments: [{ id: 'subtitle-1', text: '原始字幕' }],
          chapters: [{ title: '状态设计', startMs: 0, endMs: 1200 }],
        }),
      },
    ],
  };

  try {
    writeFileSync(fixturePath, `${JSON.stringify(record)}\n`);
    const result = runTrainingValidation(fixturePath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /secret-like value/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('LoRA training JSONL validator accepts a complete subtitle SFT contract', () => {
  const python = [
    'import importlib.util',
    'spec = importlib.util.spec_from_file_location("train_lora", "ml/subtitle-postprocessor/train_lora.py")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'module.validate_train_jsonl("scripts/tests/fixtures/valid-subtitle-train.jsonl")',
    'print("ok")',
  ].join('; ');
  const result = spawnSync('python3', ['-c', python], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'ok');
});

test('LoRA training JSONL validator accepts sparse subtitle corrections', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'subtitle-sparse-train-'));
  const fixturePath = join(tempDir, 'sparse-train.jsonl');
  const record = {
    messages: [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: JSON.stringify({
          segments: [
            { id: 'subtitle-1', startMs: 0, endMs: 1200, text: '原始字幕' },
            { id: 'subtitle-2', startMs: 1200, endMs: 2600, text: '继续讲 use state' },
          ],
        }),
      },
      {
        role: 'assistant',
        content: JSON.stringify({
          segments: [{ id: 'subtitle-2', text: '继续讲 useState' }],
          chapters: [{ title: '状态设计', startMs: 0, endMs: 2600 }],
        }),
      },
    ],
  };

  try {
    writeFileSync(fixturePath, `${JSON.stringify(record)}\n`);
    const python = [
      'import importlib.util',
      'spec = importlib.util.spec_from_file_location("train_lora", "ml/subtitle-postprocessor/train_lora.py")',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      `module.validate_train_jsonl(${JSON.stringify(fixturePath)})`,
      'print("ok")',
    ].join('; ');
    const result = spawnSync('python3', ['-c', python], {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'ok');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('dataset validator rejects empty JSONL input', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'subtitle-empty-dataset-'));
  const fixturePath = join(tempDir, 'empty.jsonl');

  try {
    writeFileSync(fixturePath, '');
    const result = spawnSync('node', ['scripts/subtitle-llm/validate-dataset.mjs', fixturePath], {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /must contain at least one subtitle fine-tuning record/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('distillation CLI rejects empty seed JSONL without writing output', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'subtitle-empty-distill-'));
  const seedPath = join(tempDir, 'empty-seed.jsonl');
  const outPath = join(tempDir, 'distilled.jsonl');

  try {
    writeFileSync(seedPath, '');
    const result = spawnSync(
      'node',
      ['scripts/subtitle-llm/distill-corpus.mjs', '--seed', seedPath, '--out', outPath],
      {
        cwd: new URL('../..', import.meta.url),
        encoding: 'utf8',
        env: { ...process.env, TEACHER_API_KEY: 'test-teacher-key' },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /seed dataset must contain at least one distillation example/);
    assert.equal(existsSync(outPath), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function runTrainingValidation(fixturePath) {
  return spawnSync(
    'python3',
    [
      'ml/subtitle-postprocessor/train_lora.py',
      '--train-jsonl',
      fixturePath,
    ],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    },
  );
}

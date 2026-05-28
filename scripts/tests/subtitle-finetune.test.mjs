import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('rejects distillation samples that omit chapters', () => {
  assert.throws(
    () => validateSubtitleTeacherResult({ segments: teacherResult.segments }, seedExample),
    /chapters/,
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

test('rejects unknown or missing subtitle segment ids in teacher output', () => {
  assert.throws(
    () =>
      validateSubtitleTeacherResult(
        {
          segments: [{ id: 'subtitle-404', text: 'bad segment' }],
          chapters: [],
        },
        seedExample,
      ),
    /every input segment exactly once/,
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
  assert.match(messages[0].content, /简体中文/);
  assert.match(messages[1].content, /Counter\.tsx/);
  assert.match(messages[1].content, /subtitle-1/);
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
  const result = spawnSync(
    'python3',
    [
      'ml/subtitle-postprocessor/train_lora.py',
      '--train-jsonl',
      'scripts/tests/fixtures/malformed-subtitle-train.jsonl',
    ],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must contain a messages list/);
});

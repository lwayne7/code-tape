import assert from 'node:assert/strict';
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

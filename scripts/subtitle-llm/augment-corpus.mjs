#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  buildTrainingRecord,
  validateSubtitleDistillationExample,
  readPromptSegments,
  validateSubtitleTeacherResult,
} from './schema.mjs';

const SEED_PATH = 'ml/subtitle-postprocessor/data/seed_examples.jsonl';
const DISTILLED_PATH = 'ml/subtitle-postprocessor/data/generated/distilled.jsonl';
const TOPICS_PATH = 'ml/subtitle-postprocessor/data/stability-topics.json';
const CURATED_PREFIX = 'stability-sparse-';
const CURATED_TEACHER_MODEL = 'curated-stability-v1';

async function main() {
  const existingSeedExamples = parseJsonl(await readFile(SEED_PATH, 'utf8'), SEED_PATH).filter(
    (example) => !String(example.id).startsWith(CURATED_PREFIX),
  );
  const existingTrainingRecords = parseJsonl(await readFile(DISTILLED_PATH, 'utf8'), DISTILLED_PATH).filter(
    (record) => !String(record.metadata?.id).startsWith(CURATED_PREFIX),
  ).map(normalizeTrainingRecordPrompt);
  const curatedExamples = buildCuratedExamples(await readCuratedTopicData());
  const curatedTrainingRecords = curatedExamples.map(({ teacherResult, ...example }) =>
    buildTrainingRecord({
      example: validateSubtitleDistillationExample(example),
      teacherResult: validateSubtitleTeacherResult(teacherResult, example),
      teacherModel: CURATED_TEACHER_MODEL,
    }),
  );

  await mkdir(dirname(DISTILLED_PATH), { recursive: true });
  await writeJsonl(SEED_PATH, [...existingSeedExamples, ...curatedExamples.map(({ teacherResult: _teacherResult, ...example }) => example)]);
  await writeJsonl(DISTILLED_PATH, [...existingTrainingRecords, ...curatedTrainingRecords]);
  console.log(
    `Wrote ${existingSeedExamples.length + curatedExamples.length} seed examples and ${
      existingTrainingRecords.length + curatedTrainingRecords.length
    } training records`,
  );
}

function normalizeTrainingRecordPrompt(record) {
  const userPayload = JSON.parse(record.messages[1].content);
  const teacherResult = JSON.parse(record.messages[2].content);
  const example = {
    id: record.metadata?.id ?? 'existing-subtitle-record',
    language: userPayload.language,
    context: userPayload.context ?? {},
    segments: readPromptSegments(userPayload),
  };
  return buildTrainingRecord({
    example: validateSubtitleDistillationExample(example),
    teacherResult: validateSubtitleTeacherResult(teacherResult, example),
    teacherModel: record.metadata?.teacherModel ?? 'existing-normalized',
  });
}

async function readCuratedTopicData() {
  const data = JSON.parse(await readFile(TOPICS_PATH, 'utf8'));
  if (!Array.isArray(data.stabilityTopics) || !Array.isArray(data.correctionTopics)) {
    throw new Error('stability topics data must contain stabilityTopics and correctionTopics arrays');
  }
  return data;
}

function buildCuratedExamples({ stabilityTopics, correctionTopics }) {
  const topics = [...stabilityTopics];
  for (let index = 0; index < 170; index += 1) {
    const base = topics[index % 10];
    const suffix = Math.floor(index / 10) + 2;
    topics.push({
      ...base,
      fileName: base.fileName.replace(/(\.[^.]+)$/u, `.variant${suffix}$1`),
      code: `${base.code}\n// variant ${suffix}: keep sparse subtitle corrections stable`,
      runtimeOutput: suffix % 2 === 0 ? 'Warning: model output omitted unchanged subtitle segments' : '',
      nonContiguousIds: suffix % 2 === 1,
      corrections: base.corrections.slice(0, suffix % 3 === 0 ? 1 : base.corrections.length),
      chapters: base.chapters,
    });
  }

  for (let index = 0; index < 240; index += 1) {
    const base = correctionTopics[index % correctionTopics.length];
    const suffix = Math.floor(index / correctionTopics.length) + 2;
    topics.push({
      ...base,
      fileName: base.fileName.replace(/(\.[^.]+)$/u, `.correction${suffix}$1`),
      code: `${base.code}\n// correction variant ${suffix}: teach frontend ASR term fixes`,
      runtimeOutput: suffix % 2 === 0 ? 'Warning: keep playback responsive while LLM runs' : '',
      nonContiguousIds: suffix % 2 === 1,
      corrections: base.corrections.slice(0, suffix % 3 === 0 ? 1 : base.corrections.length),
      chapters: base.chapters,
    });
  }

  return topics.map((topic, topicIndex) => {
    const start = topic.nonContiguousIds ? 11 : 1;
    const step = topic.nonContiguousIds ? 3 : 1;
    const segments = topic.segments.map((text, index) => ({
      id: `subtitle-${start + index * step}`,
      startMs: index * 1_200,
      endMs: index * 1_200 + 1_000,
      text,
    }));
    const correctedSegments = topic.corrections.map(([segmentIndex, text]) => ({
      id: segments[segmentIndex].id,
      text,
    }));
    const chapters = topic.chapters.map(([title, startIndex, endIndex]) => ({
      title,
      startMs: segments[startIndex].startMs,
      endMs:
        endIndex >= segments.length - 1
          ? segments[endIndex].endMs
          : segments[endIndex].startMs,
    }));
    return {
      id: `${CURATED_PREFIX}${String(topicIndex + 1).padStart(3, '0')}`,
      language: 'zh-CN',
      context: {
        fileName: topic.fileName,
        code: topic.code,
        runtimeOutput: topic.runtimeOutput ?? '',
        glossary: topic.glossary,
      },
      segments,
      teacherResult: {
        segments: correctedSegments,
        chapters,
      },
    };
  });
}

function parseJsonl(text, label) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => JSON.parse(line, (_, value) => value, `${label}:${index + 1}`));
}

async function writeJsonl(path, records) {
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

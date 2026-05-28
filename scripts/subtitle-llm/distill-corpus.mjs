#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  buildDistillationMessages,
  buildTrainingRecord,
  parseJsonObject,
  validateSubtitleDistillationExample,
  validateSubtitleTeacherResult,
} from './schema.mjs';

const DEFAULT_TEACHER_API_URL = 'https://saturday.sankuai.com';
const DEFAULT_TEACHER_MODEL = 'gpt-5.5';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seedPath = requiredArg(args, '--seed');
  const outPath = requiredArg(args, '--out');
  const apiKey = process.env.TEACHER_API_KEY;
  if (!apiKey) {
    throw new Error('TEACHER_API_KEY is required. Export it in your shell; do not write it to files.');
  }
  const teacherModel = process.env.TEACHER_MODEL ?? DEFAULT_TEACHER_MODEL;
  const chatUrl =
    process.env.TEACHER_CHAT_COMPLETIONS_URL ??
    `${(process.env.TEACHER_API_URL ?? DEFAULT_TEACHER_API_URL).replace(/\/+$/u, '')}/v1/chat/completions`;

  const examples = parseJsonl(await readFile(seedPath, 'utf8'), seedPath).map((example) =>
    validateSubtitleDistillationExample(example),
  );
  const records = [];
  for (const example of examples) {
    const teacherResult = await requestTeacherResult({
      apiKey,
      chatUrl,
      model: teacherModel,
      messages: buildDistillationMessages(example),
    });
    records.push(
      buildTrainingRecord({
        example,
        teacherResult: validateSubtitleTeacherResult(teacherResult, example),
        teacherModel,
      }),
    );
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  console.log(`Wrote ${records.length} distilled subtitle training records to ${outPath}`);
}

async function requestTeacherResult({ apiKey, chatUrl, model, messages }) {
  const response = await fetch(chatUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });
  if (!response.ok) {
    throw new Error(`teacher API request failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('teacher API response is missing choices[0].message.content');
  }
  return parseJsonObject(content, 'teacher API response content');
}

function parseJsonl(text, label) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => parseJsonObject(line, `${label}:${index + 1}`));
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Usage: distill-corpus --seed <jsonl> --out <jsonl>');
    args.set(key, value);
  }
  return args;
}

function requiredArg(args, key) {
  const value = args.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

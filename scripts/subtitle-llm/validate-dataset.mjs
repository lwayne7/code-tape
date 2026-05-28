#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

import {
  parseJsonObject,
  validateSubtitleDistillationExample,
  validateSubtitleTrainingRecord,
} from './schema.mjs';

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) throw new Error('Usage: validate-dataset <seed-or-training.jsonl> [...]');

  let total = 0;
  for (const path of paths) {
    const records = parseJsonl(await readFile(path, 'utf8'), path);
    for (const record of records) {
      if (Array.isArray(record.messages)) {
        validateSubtitleTrainingRecord(record);
      } else {
        validateSubtitleDistillationExample(record);
      }
      total += 1;
    }
  }
  if (total === 0) throw new Error('dataset must contain at least one subtitle fine-tuning record');
  console.log(`Validated ${total} subtitle fine-tuning records`);
}

function parseJsonl(text, label) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => parseJsonObject(line, `${label}:${index + 1}`));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJsonObject, validateSubtitleTrainingRecord } from './schema.mjs';

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) throw new Error('Usage: evaluate-corpus <training.jsonl> [...]');

  const records = [];
  for (const path of paths) {
    records.push(...parseJsonl(await readFile(path, 'utf8'), path));
  }
  if (records.length === 0) throw new Error('evaluation corpus must contain at least one record');

  const metrics = evaluateRecords(records);
  console.log(JSON.stringify(metrics, null, 2));
  if (metrics.invalidRecords > 0) {
    throw new Error(`${metrics.invalidRecords} invalid subtitle training records`);
  }
}

export function evaluateRecords(records) {
  const metrics = {
    records: records.length,
    invalidRecords: 0,
    jsonValidRate: 0,
    segmentCoverageRate: 0,
    chapterSignalRate: 0,
    glossaryPreservationRate: 0,
  };
  let jsonValid = 0;
  let segmentCoverage = 0;
  let chapterSignal = 0;
  let glossaryPreserved = 0;
  let glossaryTotal = 0;

  for (const record of records) {
    try {
      validateSubtitleTrainingRecord(record);
      jsonValid += 1;
      segmentCoverage += 1;
      const userPayload = parseJsonObject(record.messages[1].content, 'user training content');
      const assistantPayload = parseJsonObject(record.messages[2].content, 'assistant training content');
      const assistantText = assistantPayload.segments.map((segment) => segment.text).join('\n');
      if (assistantPayload.chapters.length > 0) chapterSignal += 1;

      const glossary = Array.isArray(userPayload.context?.glossary)
        ? userPayload.context.glossary.filter(isCodeLikeTerm)
        : [];
      const normalizedSourceSegments = normalizeTermText(
        userPayload.segments.map((segment) => segment.text).join('\n'),
      );
      const normalizedAssistantText = normalizeTermText(assistantText);
      for (const term of glossary) {
        const normalizedTerm = normalizeTermText(term);
        if (!normalizedSourceSegments.includes(normalizedTerm)) continue;
        glossaryTotal += 1;
        if (assistantText.includes(term) || normalizedAssistantText.includes(normalizedTerm)) {
          glossaryPreserved += 1;
        }
      }
    } catch {
      metrics.invalidRecords += 1;
    }
  }

  metrics.jsonValidRate = ratio(jsonValid, records.length);
  metrics.segmentCoverageRate = ratio(segmentCoverage, records.length);
  metrics.chapterSignalRate = ratio(chapterSignal, records.length);
  metrics.glossaryPreservationRate = glossaryTotal === 0 ? 1 : ratio(glossaryPreserved, glossaryTotal);
  return metrics;
}

function parseJsonl(text, label) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => parseJsonObject(line, `${label}:${index + 1}`));
}

function isCodeLikeTerm(value) {
  return typeof value === 'string' && /[A-Za-z0-9]/u.test(value);
}

function normalizeTermText(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, '');
}

function ratio(value, total) {
  return total === 0 ? 0 : Number((value / total).toFixed(4));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

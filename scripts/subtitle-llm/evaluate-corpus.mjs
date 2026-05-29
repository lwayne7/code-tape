#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJsonObject, validateSubtitleTrainingRecord } from './schema.mjs';

const QUALITY_GATE_RECORD_COUNT = 10;
const MIN_SPARSE_OUTPUT_RATE = 0.85;
const MAX_FULL_SEGMENT_OUTPUT_RATE = 0.15;
const MAX_AVERAGE_OUTPUT_SEGMENT_RATIO = 0.3;
const MIN_LONG_TRACK_RECORD_RATE = 0.75;
const MIN_CHAPTER_SIGNAL_RATE = 0.9;
const MIN_GLOSSARY_PRESERVATION_RATE = 0.95;
const LONG_TRACK_SEGMENT_COUNT = 6;

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
  assertQualityGate(metrics);
}

export function evaluateRecords(records) {
  const metrics = {
    records: records.length,
    invalidRecords: 0,
    jsonValidRate: 0,
    sparseSegmentReferenceRate: 0,
    chapterSignalRate: 0,
    glossaryPreservationRate: 0,
    sparseOutputRate: 0,
    fullSegmentOutputRate: 0,
    emptyCorrectionRate: 0,
    longTrackRecordRate: 0,
    averageInputSegments: 0,
    averageOutputSegments: 0,
    averageOutputSegmentRatio: 0,
  };
  let jsonValid = 0;
  let sparseSegmentReferences = 0;
  let chapterSignal = 0;
  let glossaryPreserved = 0;
  let glossaryTotal = 0;
  let sparseOutputs = 0;
  let fullSegmentOutputs = 0;
  let emptyCorrections = 0;
  let longTrackRecords = 0;
  let totalInputSegments = 0;
  let totalOutputSegments = 0;
  let totalOutputSegmentRatio = 0;

  for (const record of records) {
    try {
      validateSubtitleTrainingRecord(record);
      jsonValid += 1;
      sparseSegmentReferences += 1;
      const userPayload = parseJsonObject(record.messages[1].content, 'user training content');
      const assistantPayload = parseJsonObject(record.messages[2].content, 'assistant training content');
      const inputSegments = readPromptSegments(userPayload);
      const inputSegmentCount = inputSegments.length;
      const outputSegmentCount = assistantPayload.segments.length;
      totalInputSegments += inputSegmentCount;
      totalOutputSegments += outputSegmentCount;
      totalOutputSegmentRatio += inputSegmentCount === 0 ? 0 : outputSegmentCount / inputSegmentCount;
      if (inputSegmentCount >= LONG_TRACK_SEGMENT_COUNT) longTrackRecords += 1;
      if (outputSegmentCount === 0) emptyCorrections += 1;
      if (outputSegmentCount < inputSegmentCount) sparseOutputs += 1;
      if (outputSegmentCount === inputSegmentCount) fullSegmentOutputs += 1;
      const finalSubtitleText = buildFinalSubtitleText(inputSegments, assistantPayload.segments);
      if (assistantPayload.chapters.length > 0) chapterSignal += 1;

      const glossary = Array.isArray(userPayload.context?.glossary)
        ? userPayload.context.glossary.filter(isCodeLikeTerm)
        : [];
      const normalizedSourceSegments = normalizeTermText(
        inputSegments.map((segment) => segment.text).join('\n'),
      );
      const normalizedFinalSubtitleText = normalizeTermText(finalSubtitleText);
      for (const term of glossary) {
        const normalizedTerm = normalizeTermText(term);
        if (!normalizedSourceSegments.includes(normalizedTerm)) continue;
        glossaryTotal += 1;
        if (finalSubtitleText.includes(term) || normalizedFinalSubtitleText.includes(normalizedTerm)) {
          glossaryPreserved += 1;
        }
      }
    } catch {
      metrics.invalidRecords += 1;
    }
  }

  metrics.jsonValidRate = ratio(jsonValid, records.length);
  metrics.sparseSegmentReferenceRate = ratio(sparseSegmentReferences, records.length);
  metrics.chapterSignalRate = ratio(chapterSignal, records.length);
  metrics.glossaryPreservationRate = glossaryTotal === 0 ? 1 : ratio(glossaryPreserved, glossaryTotal);
  metrics.sparseOutputRate = ratio(sparseOutputs, records.length);
  metrics.fullSegmentOutputRate = ratio(fullSegmentOutputs, records.length);
  metrics.emptyCorrectionRate = ratio(emptyCorrections, records.length);
  metrics.longTrackRecordRate = ratio(longTrackRecords, records.length);
  metrics.averageInputSegments = average(totalInputSegments, jsonValid);
  metrics.averageOutputSegments = average(totalOutputSegments, jsonValid);
  metrics.averageOutputSegmentRatio = average(totalOutputSegmentRatio, jsonValid);
  return metrics;
}

function assertQualityGate(metrics) {
  if (metrics.records < QUALITY_GATE_RECORD_COUNT) return;
  const failures = [];
  if (metrics.sparseOutputRate < MIN_SPARSE_OUTPUT_RATE) {
    failures.push(`sparseOutputRate ${metrics.sparseOutputRate} < ${MIN_SPARSE_OUTPUT_RATE}`);
  }
  if (metrics.fullSegmentOutputRate > MAX_FULL_SEGMENT_OUTPUT_RATE) {
    failures.push(`fullSegmentOutputRate ${metrics.fullSegmentOutputRate} > ${MAX_FULL_SEGMENT_OUTPUT_RATE}`);
  }
  if (metrics.averageOutputSegmentRatio > MAX_AVERAGE_OUTPUT_SEGMENT_RATIO) {
    failures.push(
      `averageOutputSegmentRatio ${metrics.averageOutputSegmentRatio} > ${MAX_AVERAGE_OUTPUT_SEGMENT_RATIO}`,
    );
  }
  if (metrics.longTrackRecordRate < MIN_LONG_TRACK_RECORD_RATE) {
    failures.push(`longTrackRecordRate ${metrics.longTrackRecordRate} < ${MIN_LONG_TRACK_RECORD_RATE}`);
  }
  if (metrics.chapterSignalRate < MIN_CHAPTER_SIGNAL_RATE) {
    failures.push(`chapterSignalRate ${metrics.chapterSignalRate} < ${MIN_CHAPTER_SIGNAL_RATE}`);
  }
  if (metrics.glossaryPreservationRate < MIN_GLOSSARY_PRESERVATION_RATE) {
    failures.push(
      `glossaryPreservationRate ${metrics.glossaryPreservationRate} < ${MIN_GLOSSARY_PRESERVATION_RATE}`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`subtitle corpus quality gate failed: ${failures.join('; ')}`);
  }
}

function readPromptSegments(payload) {
  if (Array.isArray(payload.inputSegments) && Array.isArray(payload.timeline)) {
    const timelineById = new Map(payload.timeline.map((item) => [item.id, item]));
    return payload.inputSegments.map((segment) => ({
      ...segment,
      startMs: timelineById.get(segment.id)?.startMs,
      endMs: timelineById.get(segment.id)?.endMs,
    }));
  }
  return payload.inputSegments ?? payload.segments;
}

function buildFinalSubtitleText(inputSegments, correctionSegments) {
  const correctionsById = new Map(correctionSegments.map((segment) => [segment.id, segment.text]));
  return inputSegments
    .map((segment) => correctionsById.get(segment.id) ?? segment.text)
    .join('\n');
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

function average(value, total) {
  return total === 0 ? 0 : Number((value / total).toFixed(4));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

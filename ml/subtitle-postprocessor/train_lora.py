#!/usr/bin/env python3
"""LoRA fine-tuning entry point for the code-tape subtitle postprocessor."""

from __future__ import annotations

import argparse
import json
import math
import os


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Fine-tune a small subtitle postprocessor model with LoRA.")
    parser.add_argument("--train-jsonl", required=True, help="Distilled SFT JSONL from scripts/subtitle-llm/distill-corpus.mjs")
    parser.add_argument("--base-model", default="Qwen/Qwen2.5-0.5B-Instruct", help="Base instruct model for LoRA")
    parser.add_argument("--output-dir", default="ml/subtitle-postprocessor/output/lora", help="Adapter output directory")
    parser.add_argument("--hub-model-id", help="Optional Hugging Face Hub repo id to push the adapter")
    parser.add_argument("--max-seq-length", type=int, default=4096)
    parser.add_argument("--epochs", type=float, default=3.0)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--gradient-accumulation-steps", type=int, default=8)
    parser.add_argument(
        "--trust-remote-code",
        action="store_true",
        help="Opt in to model repository Python code. Do not combine with --hub-model-id.",
    )
    return parser


def validate_train_jsonl(path: str) -> None:
    record_count = 0
    with open(path, "r", encoding="utf-8") as file:
        for line_number, line in enumerate(file, start=1):
            stripped_line = line.strip()
            if not stripped_line:
                continue
            try:
                record = json.loads(stripped_line)
            except json.JSONDecodeError as error:
                raise SystemExit(f"{path}:{line_number} is not valid JSON: {error}") from error
            if not isinstance(record, dict):
                raise SystemExit(f"{path}:{line_number} must be a JSON object")
            validate_training_record(record, path, line_number)
            record_count += 1
    if record_count == 0:
        raise SystemExit(f"{path} must contain at least one training record")


def validate_training_record(record: dict, path: str, line_number: int) -> None:
    messages = record.get("messages")
    if not isinstance(messages, list) or not messages:
        raise SystemExit(f"{path}:{line_number} must contain a messages list")
    if len(messages) != 3:
        raise SystemExit(f"{path}:{line_number} messages must contain exactly system, user, and assistant turns")

    for message_index, expected_role in enumerate(("system", "user", "assistant")):
        message = messages[message_index]
        if not isinstance(message, dict):
            raise SystemExit(f"{path}:{line_number} messages[{message_index}] must be an object")
        if message.get("role") != expected_role:
            raise SystemExit(f"{path}:{line_number} messages[{message_index}].role must be {expected_role}")
        if not isinstance(message.get("content"), str) or not message["content"].strip():
            raise SystemExit(f"{path}:{line_number} messages[{message_index}].content is required")

    user_payload = parse_json_object(messages[1]["content"], path, line_number, "user content")
    assistant_payload = parse_json_object(messages[2]["content"], path, line_number, "assistant content")
    segments = validate_user_segments(user_payload, path, line_number)
    validate_assistant_payload(assistant_payload, segments, path, line_number)


def parse_json_object(text: str, path: str, line_number: int, label: str) -> dict:
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise SystemExit(f"{path}:{line_number} {label} is not valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise SystemExit(f"{path}:{line_number} {label} must be a JSON object")
    return value


def validate_user_segments(payload: dict, path: str, line_number: int) -> list[dict]:
    segments = payload.get("segments")
    if not isinstance(segments, list) or not segments:
        raise SystemExit(f"{path}:{line_number} user JSON must contain a non-empty segments array")
    seen_ids = set()
    previous_end_ms = -math.inf
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict):
            raise SystemExit(f"{path}:{line_number} user segments[{index}] must be an object")
        segment_id = segment.get("id")
        start_ms = segment.get("startMs")
        end_ms = segment.get("endMs")
        if not is_non_empty_string(segment_id):
            raise SystemExit(f"{path}:{line_number} user segments[{index}].id is required")
        if not is_finite_number(start_ms) or not is_finite_number(end_ms):
            raise SystemExit(f"{path}:{line_number} user segments[{index}] must contain numeric startMs and endMs")
        if end_ms <= start_ms:
            raise SystemExit(f"{path}:{line_number} user segments[{index}] endMs must be after startMs")
        if start_ms < previous_end_ms:
            raise SystemExit(f"{path}:{line_number} user segments must be ordered and non-overlapping")
        if segment_id in seen_ids:
            raise SystemExit(f"{path}:{line_number} duplicate user segment id: {segment_id}")
        if not is_non_empty_string(segment.get("text")):
            raise SystemExit(f"{path}:{line_number} user segments[{index}].text is required")
        seen_ids.add(segment_id)
        previous_end_ms = end_ms
    return segments


def validate_assistant_payload(payload: dict, input_segments: list[dict], path: str, line_number: int) -> None:
    segments = payload.get("segments")
    chapters = payload.get("chapters")
    if not isinstance(segments, list) or not isinstance(chapters, list):
        raise SystemExit(f"{path}:{line_number} assistant JSON must contain segments and chapters arrays")
    if not chapters:
        raise SystemExit(f"{path}:{line_number} chapters must contain at least one chapter")

    input_ids = {segment["id"] for segment in input_segments}
    seen_ids = set()
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict):
            raise SystemExit(f"{path}:{line_number} assistant segments[{index}] must be an object")
        segment_id = segment.get("id")
        if not is_non_empty_string(segment_id) or not is_non_empty_string(segment.get("text")):
            raise SystemExit(f"{path}:{line_number} assistant segments[{index}] must contain id and text strings")
        if segment_id not in input_ids or segment_id in seen_ids:
            raise SystemExit(f"{path}:{line_number} assistant must include every input segment exactly once")
        seen_ids.add(segment_id)
    if len(seen_ids) != len(input_ids):
        raise SystemExit(f"{path}:{line_number} assistant must include every input segment exactly once")

    validate_chapters(chapters, input_segments[0]["startMs"], input_segments[-1]["endMs"], path, line_number)


def validate_chapters(chapters: list, timeline_start_ms: float, timeline_end_ms: float, path: str, line_number: int) -> None:
    previous_end_ms = -math.inf
    for index, chapter in enumerate(chapters):
        if not isinstance(chapter, dict):
            raise SystemExit(f"{path}:{line_number} chapters[{index}] must be an object")
        start_ms = chapter.get("startMs")
        end_ms = chapter.get("endMs")
        if not is_non_empty_string(chapter.get("title")):
            raise SystemExit(f"{path}:{line_number} chapters[{index}].title is required")
        if not is_finite_number(start_ms):
            raise SystemExit(f"{path}:{line_number} chapters[{index}].startMs is required")
        if start_ms < 0:
            raise SystemExit(f"{path}:{line_number} chapters[{index}].startMs must be non-negative")
        if end_ms is not None and not is_finite_number(end_ms):
            raise SystemExit(f"{path}:{line_number} chapters[{index}].endMs must be a number when present")
        if end_ms is not None and end_ms <= start_ms:
            raise SystemExit(f"{path}:{line_number} chapters[{index}].endMs must be after startMs")
        if start_ms < timeline_start_ms or start_ms > timeline_end_ms:
            raise SystemExit(f"{path}:{line_number} chapters must stay within the source subtitle timeline")
        if end_ms is not None and end_ms > timeline_end_ms:
            raise SystemExit(f"{path}:{line_number} chapters must stay within the source subtitle timeline")
        if start_ms < previous_end_ms:
            raise SystemExit(f"{path}:{line_number} chapters must be ordered and non-overlapping")
        previous_end_ms = end_ms if end_ms is not None else start_ms


def is_non_empty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def is_finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def main() -> None:
    args = build_parser().parse_args()
    if args.hub_model_id and not os.environ.get("HF_TOKEN"):
        raise SystemExit("HF_TOKEN is required when --hub-model-id is set")
    if args.trust_remote_code and args.hub_model_id:
        raise SystemExit("Do not combine --trust-remote-code with --hub-model-id; publish from a separate trusted process.")
    validate_train_jsonl(args.train_jsonl)

    from datasets import load_dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from trl import SFTConfig, SFTTrainer

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=args.trust_remote_code)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        device_map="auto",
        trust_remote_code=args.trust_remote_code,
    )
    train_dataset = load_dataset("json", data_files=args.train_jsonl, split="train")

    def format_record(record: dict) -> str:
        return tokenizer.apply_chat_template(
            record["messages"],
            tokenize=False,
            add_generation_prompt=False,
        )

    trainer = SFTTrainer(
        model=model,
        train_dataset=train_dataset,
        formatting_func=format_record,
        peft_config=LoraConfig(
            r=16,
            lora_alpha=32,
            lora_dropout=0.05,
            bias="none",
            task_type="CAUSAL_LM",
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        ),
        args=SFTConfig(
            output_dir=args.output_dir,
            max_seq_length=args.max_seq_length,
            num_train_epochs=args.epochs,
            learning_rate=args.learning_rate,
            per_device_train_batch_size=args.batch_size,
            gradient_accumulation_steps=args.gradient_accumulation_steps,
            logging_steps=5,
            save_strategy="epoch",
            packing=False,
            report_to=[],
        ),
    )
    trainer.train()
    trainer.save_model(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)

    if args.hub_model_id:
        trainer.model.push_to_hub(args.hub_model_id, private=False)
        tokenizer.push_to_hub(args.hub_model_id, private=False)


if __name__ == "__main__":
    main()

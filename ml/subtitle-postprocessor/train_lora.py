#!/usr/bin/env python3
"""LoRA fine-tuning entry point for the code-tape subtitle postprocessor."""

from __future__ import annotations

import argparse
import inspect
import json
import math
import os
import re
import sys


SECRET_PATTERNS = (
    re.compile(r"\bhf_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._-]{20,}\b"),
)

ASSISTANT_MASK_CHAT_TEMPLATE = (
    "{% for message in messages %}"
    "{% if loop.first and messages[0]['role'] != 'system' %}"
    "{{ '<|im_start|>system\nYou are a helpful AI assistant named SmolLM, trained by Hugging Face<|im_end|>\n' }}"
    "{% endif %}"
    "{{ '<|im_start|>' + message['role'] + '\n' }}"
    "{% if message['role'] == 'assistant' %}"
    "{% generation %}{{ message['content'] }}{% endgeneration %}"
    "{% else %}"
    "{{ message['content'] }}"
    "{% endif %}"
    "{{ '<|im_end|>\n' }}"
    "{% endfor %}"
    "{% if add_generation_prompt %}{{ '<|im_start|>assistant\n' }}{% endif %}"
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Fine-tune a small subtitle postprocessor model with LoRA.")
    parser.add_argument("--train-jsonl", required=True, help="Distilled SFT JSONL from scripts/subtitle-llm/distill-corpus.mjs")
    parser.add_argument("--base-model", default="HuggingFaceTB/SmolLM2-135M-Instruct", help="Base instruct model for LoRA")
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


def require_supported_python() -> None:
    if sys.version_info < (3, 10):
        raise SystemExit("Python >= 3.10 is required for the subtitle fine-tuning toolchain")


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
            assert_no_secrets(record, f"{path}:{line_number}")
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
    segments = validate_user_segments(read_prompt_segments(user_payload), path, line_number)
    validate_assistant_payload(assistant_payload, segments, path, line_number)


def assert_no_secrets(value: object, location: str) -> None:
    if isinstance(value, str):
        for pattern in SECRET_PATTERNS:
            if pattern.search(value):
                raise SystemExit(f"secret-like value found at {location}")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            assert_no_secrets(item, f"{location}[{index}]")
        return
    if isinstance(value, dict):
        for key, child in value.items():
            assert_no_secrets(child, f"{location}.{key}")


def parse_json_object(text: str, path: str, line_number: int, label: str) -> dict:
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise SystemExit(f"{path}:{line_number} {label} is not valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise SystemExit(f"{path}:{line_number} {label} must be a JSON object")
    return value


def read_prompt_segments(payload: dict) -> object:
    # Keep this cross-language copy aligned with scripts/subtitle-llm/schema.mjs::readPromptSegments.
    if isinstance(payload.get("inputSegments"), list) and isinstance(payload.get("timeline"), list):
        timeline_by_id = {
            item.get("id"): item
            for item in payload["timeline"]
            if isinstance(item, dict)
        }
        return [
            {
                **segment,
                "startMs": timeline_by_id.get(segment.get("id"), {}).get("startMs"),
                "endMs": timeline_by_id.get(segment.get("id"), {}).get("endMs"),
            }
            for segment in payload["inputSegments"]
            if isinstance(segment, dict)
        ]
    return payload.get("inputSegments", payload.get("segments"))


def validate_user_segments(segments: object, path: str, line_number: int) -> list[dict]:
    if not isinstance(segments, list) or not segments:
        raise SystemExit(f"{path}:{line_number} user JSON must contain a non-empty inputSegments array")
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
        if segment_id not in input_ids:
            raise SystemExit(f"{path}:{line_number} assistant references unknown segment: {segment_id}")
        if segment_id in seen_ids:
            raise SystemExit(f"{path}:{line_number} assistant repeats segment: {segment_id}")
        seen_ids.add(segment_id)

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
    require_supported_python()

    from datasets import load_dataset
    from peft import LoraConfig, get_peft_model
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        DataCollatorForSeq2Seq,
        Trainer,
        TrainingArguments,
    )

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=args.trust_remote_code)
    tokenizer.chat_template = ASSISTANT_MASK_CHAT_TEMPLATE
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        device_map="auto",
        trust_remote_code=args.trust_remote_code,
    )
    train_dataset = load_dataset("json", data_files=args.train_jsonl, split="train")
    tokenized_dataset = train_dataset.map(
        lambda record: tokenize_training_record(record, tokenizer, args.max_seq_length),
        remove_columns=train_dataset.column_names,
    )

    model = get_peft_model(
        model,
        LoraConfig(
            r=16,
            lora_alpha=32,
            lora_dropout=0.05,
            bias="none",
            task_type="CAUSAL_LM",
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        ),
    )
    training_args_kwargs = {
        "output_dir": args.output_dir,
        "num_train_epochs": args.epochs,
        "learning_rate": args.learning_rate,
        "per_device_train_batch_size": args.batch_size,
        "gradient_accumulation_steps": args.gradient_accumulation_steps,
        "logging_steps": 5,
        "save_strategy": "no",
        "report_to": [],
        "optim": "adamw_torch",
        "remove_unused_columns": False,
    }
    if "use_mps_device" in inspect.signature(TrainingArguments).parameters:
        training_args_kwargs["use_mps_device"] = False

    trainer = Trainer(
        model=model,
        args=TrainingArguments(**training_args_kwargs),
        train_dataset=tokenized_dataset,
        data_collator=DataCollatorForSeq2Seq(tokenizer=tokenizer, padding=True, label_pad_token_id=-100),
    )
    trainer.train()
    trainer.save_model(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)

    if args.hub_model_id:
        trainer.model.push_to_hub(args.hub_model_id, private=False)
        tokenizer.push_to_hub(args.hub_model_id, private=False)


def tokenize_training_record(record: dict, tokenizer, max_seq_length: int) -> dict:
    messages = record["messages"]
    prompt_messages = messages[:2]
    assistant_content = messages[2]["content"]
    prompt_text = tokenizer.apply_chat_template(prompt_messages, add_generation_prompt=True, tokenize=False)
    full_text = tokenizer.apply_chat_template(messages, add_generation_prompt=False, tokenize=False)
    if not full_text.startswith(prompt_text):
        raise ValueError("training prompt is not a prefix of the full assistant record")
    assistant_start = full_text.find(assistant_content, len(prompt_text))
    if assistant_start < 0:
        raise ValueError("assistant content is not present after the training prompt")
    assistant_end = assistant_start + len(assistant_content)

    full_tokens = tokenize_with_offsets(tokenizer, full_text)
    full_ids = full_tokens["input_ids"]
    offset_mapping = full_tokens["offset_mapping"]
    input_ids = full_ids[:max_seq_length]
    labels = []
    for token_id, offset in zip(input_ids, offset_mapping[:max_seq_length]):
        start, end = offset
        labels.append(token_id if start >= assistant_start and end <= assistant_end and end > start else -100)
    if all(label == -100 for label in labels):
        raise ValueError("training record contains no assistant labels after truncation")
    return {
        "input_ids": input_ids,
        "attention_mask": [1] * len(input_ids),
        "labels": labels,
    }


def tokenize_with_offsets(tokenizer, text: str) -> dict:
    try:
        tokens = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True)
    except TypeError as error:
        raise ValueError("tokenizer must support offset mappings for assistant-only labels") from error
    if "offset_mapping" not in tokens:
        raise ValueError("tokenizer did not return offset mappings for assistant-only labels")
    if len(tokens["input_ids"]) != len(tokens["offset_mapping"]):
        raise ValueError("tokenizer offset mapping length does not match input ids")
    return tokens


if __name__ == "__main__":
    main()

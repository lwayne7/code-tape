#!/usr/bin/env python3
"""LoRA fine-tuning entry point for the code-tape subtitle postprocessor."""

from __future__ import annotations

import argparse
import json
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
            messages = record.get("messages")
            if not isinstance(messages, list) or not messages:
                raise SystemExit(f"{path}:{line_number} must contain a messages list")
            for message_index, message in enumerate(messages):
                if not isinstance(message, dict):
                    raise SystemExit(f"{path}:{line_number} messages[{message_index}] must be an object")
                if not isinstance(message.get("role"), str) or not isinstance(message.get("content"), str):
                    raise SystemExit(f"{path}:{line_number} messages[{message_index}] must contain role and content strings")
            record_count += 1
    if record_count == 0:
        raise SystemExit(f"{path} must contain at least one training record")


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

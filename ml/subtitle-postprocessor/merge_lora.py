#!/usr/bin/env python3
"""Merge a subtitle postprocessor LoRA adapter into a full Hugging Face model."""

from __future__ import annotations

import argparse
import os
import sys


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Merge a code-tape subtitle LoRA adapter for browser export.")
    parser.add_argument("--base-model", default="HuggingFaceTB/SmolLM2-135M-Instruct")
    parser.add_argument("--adapter-dir", default="ml/subtitle-postprocessor/output/lora")
    parser.add_argument("--output-dir", default="ml/subtitle-postprocessor/output/merged")
    parser.add_argument("--hub-model-id", help="Optional Hugging Face Hub repo id for the merged public model")
    parser.add_argument(
        "--trust-remote-code",
        action="store_true",
        help="Opt in to model repository Python code. Do not combine with --hub-model-id.",
    )
    return parser


def require_supported_python() -> None:
    if sys.version_info < (3, 10):
        raise SystemExit("Python >= 3.10 is required for the subtitle fine-tuning toolchain")


def load_tokenizer(auto_tokenizer, adapter_dir: str, base_model: str, trust_remote_code: bool):
    last_error: Exception | None = None
    for source in (adapter_dir, base_model):
        try:
            return auto_tokenizer.from_pretrained(source, trust_remote_code=trust_remote_code)
        except (OSError, ValueError) as error:
            last_error = error
    if last_error is not None:
        raise last_error
    raise RuntimeError("no tokenizer source configured")


def main() -> None:
    require_supported_python()
    args = build_parser().parse_args()
    if args.hub_model_id and not os.environ.get("HF_TOKEN"):
        raise SystemExit("HF_TOKEN is required when --hub-model-id is set")
    if args.trust_remote_code and args.hub_model_id:
        raise SystemExit("Do not combine --trust-remote-code with --hub-model-id; publish from a separate trusted process.")

    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = load_tokenizer(AutoTokenizer, args.adapter_dir, args.base_model, args.trust_remote_code)
    model = AutoModelForCausalLM.from_pretrained(args.base_model, device_map="auto", trust_remote_code=args.trust_remote_code)
    merged_model = PeftModel.from_pretrained(model, args.adapter_dir).merge_and_unload()
    merged_model.save_pretrained(args.output_dir, safe_serialization=True)
    tokenizer.save_pretrained(args.output_dir)

    if args.hub_model_id:
        merged_model.push_to_hub(args.hub_model_id, private=False)
        tokenizer.push_to_hub(args.hub_model_id, private=False)


if __name__ == "__main__":
    main()

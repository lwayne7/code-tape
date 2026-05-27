import * as RadixSlider from "@radix-ui/react-slider";
import { forwardRef } from "react";
import { cn } from "./utils/cn";

export type SliderProps = {
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  className?: string;
  /** 用于回放进度条等连续条；compact 用于音量等场景 */
  variant?: "default" | "compact";
};

export const Slider = forwardRef<HTMLSpanElement, SliderProps>(function Slider(
  { value, min, max, step = 1, disabled, ariaLabel, onChange, onCommit, className, variant = "default" },
  _ref,
) {
  return (
    <RadixSlider.Root
      className={cn(
        "relative flex w-full select-none items-center",
        variant === "compact" ? "h-5" : "h-6",
        disabled ? "opacity-50" : "",
        className,
      )}
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(values) => onChange(values[0] ?? min)}
      onValueCommit={(values) => onCommit?.(values[0] ?? min)}
      aria-label={ariaLabel}
    >
      <RadixSlider.Track className="relative h-1 w-full grow rounded-full bg-border">
        <RadixSlider.Range className="absolute h-full rounded-full bg-primary" />
      </RadixSlider.Track>
      <RadixSlider.Thumb
        aria-label={ariaLabel}
        className={cn(
          "block rounded-full bg-foreground shadow-elevation-2 transition-transform duration-150 ease-out-soft",
          variant === "compact" ? "h-3 w-3" : "h-4 w-4",
          "hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        )}
      />
    </RadixSlider.Root>
  );
});

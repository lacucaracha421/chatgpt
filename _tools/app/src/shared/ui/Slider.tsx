import type { InputHTMLAttributes } from "react";

type SliderProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: string;
};

export function Slider({ label, ...props }: SliderProps) {
  return (
    <label className="ui-slider">
      <span>{label}</span>
      <input type="range" aria-label={label} {...props} />
    </label>
  );
}

import { Slider } from "./Slider";

export function PerRowControl({ value, min, max, onChange }: { value: number; min: number; max: number; onChange(value: number): void }) {
  return <div className="ui-per-row">
    <Slider label="한 줄에" min={min} max={max} step={1} value={value} aria-valuetext={`${value}개`} onChange={event => onChange(Number(event.target.value))} />
    <output>{value}개</output>
  </div>;
}

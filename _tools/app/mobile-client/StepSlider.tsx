import type {CSSProperties} from 'react';
/**
 * A touch-friendly stepped slider: a native range input (keyboard, TalkBack and drag work as
 * usual) with the current value named above it and the default step marked on the track.
 */
export function StepSlider({label,count,index,defaultIndex,valueText,onChange,className=''}:{label:string;count:number;index:number;defaultIndex?:number;valueText(index:number):string;onChange(index:number):void;className?:string}) {
  const text=(value:number)=>`${valueText(value)}${value===defaultIndex?' · 기본':''}`;
  const at=(value:number)=>`${count>1?value/(count-1):0}`;
  return <div className={`step-slider${className?` ${className}`:''}`}>
    <div className="step-slider__head"><span className="step-slider__label">{label}</span><output className="step-slider__value">{text(index)}</output></div>
    <div className="step-slider__track" style={{'--step-at':at(index)} as CSSProperties}>
      <input type="range" min={0} max={count-1} step={1} value={index} aria-label={label} aria-valuetext={text(index)} onChange={event=>onChange(Number(event.target.value))}/>
      {defaultIndex!=null&&<span className="step-slider__default" style={{'--step-at':at(defaultIndex)} as CSSProperties} aria-hidden="true"/>}
    </div>
  </div>;
}

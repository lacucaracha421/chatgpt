import { useId, type PropsWithChildren, type SelectHTMLAttributes } from "react";

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
};

export function Select({ children, id, label, ...props }: PropsWithChildren<SelectProps>) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  return (
    <label className="ui-select" htmlFor={selectId}>
      <span>{label}</span>
      <select id={selectId} {...props}>{children}</select>
    </label>
  );
}

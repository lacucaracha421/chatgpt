import { useId, type InputHTMLAttributes } from "react";

type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
};

export function TextField({ error, id, label, ...props }: TextFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;

  return (
    <label className="ui-text-field" htmlFor={inputId}>
      <span>{label}</span>
      <input
        id={inputId}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={Boolean(error)}
        {...props}
      />
      {error && <span id={errorId} role="alert">{error}</span>}
    </label>
  );
}

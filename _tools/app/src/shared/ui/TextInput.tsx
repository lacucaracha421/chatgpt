import { cloneElement, useId, type ComponentType, type InputHTMLAttributes, type ReactElement, type SVGProps } from "react";

type TextInputIcon = ComponentType<SVGProps<SVGSVGElement>>;

export type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
  className?: string;
  icon?: TextInputIcon;
};

export function TextInput({ className, icon: Icon, ...props }: TextInputProps) {
  const inputClassName = className;

  if (!Icon) {
    return <input {...props} className={["ui-text-input", inputClassName].filter(Boolean).join(" ")} />;
  }

  return (
    <div className="ui-text-input">
      <Icon aria-hidden="true" />
      <input {...props} className={inputClassName} />
    </div>
  );
}

type FieldControlProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "false" | "true";
};

export type FieldProps = {
  label: string;
  error?: string;
  children: ReactElement<FieldControlProps>;
};

// Field wraps one TextInput or native input and owns its label/error ARIA wiring.
export function Field({ children, error, label }: FieldProps) {
  const generatedId = useId();
  const inputId = children.props.id ?? generatedId;
  const errorId = `${inputId}-error`;
  const existingDescribedBy = children.props["aria-describedby"];
  const describedBy = error ? [existingDescribedBy, errorId].filter(Boolean).join(" ") : existingDescribedBy;
  const control = cloneElement(children, {
    id: inputId,
    "aria-describedby": describedBy || undefined,
    "aria-invalid": Boolean(error),
  });

  return (
    <label className="ui-field">
      <span>{label}</span>
      {control}
      {error && <span className="ui-field__error" role="alert" id={errorId}>{error}</span>}
    </label>
  );
}

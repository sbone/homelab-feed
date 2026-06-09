import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { className, label, ...props },
  ref,
) {
  return (
    <label className={cn("ui-switch", className)}>
      <input ref={ref} type="checkbox" {...props} />
      <span className="ui-switch-track" aria-hidden="true">
        <span className="ui-switch-thumb" />
      </span>
      <span>{label}</span>
    </label>
  );
});

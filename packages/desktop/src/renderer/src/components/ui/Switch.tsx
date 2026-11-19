import type { ComponentProps } from "react";

export interface SwitchProps
	extends Omit<ComponentProps<"button">, "children" | "onClick" | "role" | "type"> {
	checked: boolean;
	/** 三态：部分选中（如批量开关中一组模型仅部分可见）；视觉为 thumb 居中 + 中间色 */
	indeterminate?: boolean;
	/** 密集表单中的紧凑尺寸；默认保持现有 36×20 外观。 */
	compact?: boolean;
	onCheckedChange: (checked: boolean) => void;
}

/** 统一的设置开关：受控、键盘可达、disabled 时保持原生禁用语义。 */
export function Switch({
	checked,
	indeterminate = false,
	compact = false,
	onCheckedChange,
	className = "",
	disabled,
	...props
}: SwitchProps) {
	const mixed = indeterminate && !disabled;
	const trackClass = compact ? "h-4 w-7" : "h-5 w-9";
	const thumbClass = compact
		? `top-0.5 h-3 w-3 ${mixed ? "left-1/2 -translate-x-1/2" : checked ? "left-3.5" : "left-0.5"}`
		: `top-0.5 h-4 w-4 ${mixed ? "left-1/2 -translate-x-1/2" : checked ? "left-[18px]" : "left-0.5"}`;
	return (
		<button
			type="button"
			role="switch"
			aria-checked={mixed ? "mixed" : checked}
			disabled={disabled}
			onClick={() => onCheckedChange(!checked)}
			className={`relative shrink-0 rounded-full transition-colors ${trackClass} ${
				checked ? "bg-ink" : "bg-switch-off"
			} disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
			{...props}
		>
			<span className={`absolute rounded-full bg-surface shadow transition-all ${thumbClass}`} />
		</button>
	);
}

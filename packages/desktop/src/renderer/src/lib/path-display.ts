/** 仅用于展示：兼容 POSIX/Windows 分隔符，不修改用于导航、分组或 IO 的原始路径。 */
export function pathLastSegment(path: string): string | undefined {
	return path.split(/[\\/]/).filter(Boolean).pop();
}

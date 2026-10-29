/**
 * 会话路径的词法身份，不执行 IO，也不是路径权限校验。
 * 后端先 resolve 并显式传宿主平台；renderer 对服务端绝对路径按盘符/UNC 推断。
 * 相对路径没有工作目录证据，只保留原值，不能猜成绝对路径。
 */
function windowsPath(path: string): boolean {
	return /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
}

export function sessionPathKey(path: string, windows = windowsPath(path)): string {
	const value = windows ? path.replace(/\\/g, "/") : path;
	let root: string;
	let rest: string;
	const drive = windows ? /^([a-z]:)\/(.*)$/i.exec(value) : null;
	const unc = windows ? /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(value) : null;
	if (drive) {
		root = `${drive[1]}/`;
		rest = drive[2] ?? "";
	} else if (unc) {
		root = `//${unc[1]}/${unc[2]}/`;
		rest = unc[3] ?? "";
	} else if (value.startsWith("/")) {
		root = "/";
		rest = value.slice(1);
	} else return path;
	const parts: string[] = [];
	for (const part of rest.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	const normalized = root + parts.join("/");
	return windows ? normalized.toLowerCase() : normalized;
}

export function sameSessionPath(
	left: string,
	right: string,
	windows = windowsPath(left) || windowsPath(right),
): boolean {
	return sessionPathKey(left, windows) === sessionPathKey(right, windows);
}

import { isAbsolute, relative, resolve, sep } from "node:path";
import { sessionPathKey } from "@percho/shared";

export function backendSessionPathKey(path: string): string {
	return sessionPathKey(resolve(path), process.platform === "win32");
}

export function isSessionPathDescendant(root: string, path: string): boolean {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(path);
	const rel = relative(resolvedRoot, resolvedPath);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
	return backendSessionPathKey(resolve(resolvedRoot, rel)) === backendSessionPathKey(resolvedPath);
}

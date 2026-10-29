import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSessionPathDescendant } from "./session-paths";

function containedFile(root: string, filePath: string): boolean {
	return isSessionPathDescendant(root, filePath);
}

export function subagentSessionsRoot(agentDir: string = getAgentDir()): string {
	return join(agentDir, "sessions-subagents");
}

export function ordinarySessionsRoot(agentDir: string = getAgentDir()): string {
	return join(agentDir, "sessions");
}

export function isSubagentSessionPath(filePath: string, agentDir?: string): boolean {
	return containedFile(subagentSessionsRoot(agentDir), filePath);
}

export function isOrdinarySessionPath(filePath: string, agentDir?: string): boolean {
	return containedFile(ordinarySessionsRoot(agentDir), filePath);
}

async function validateSessionFile(
	filePath: string,
	rootPath: string,
	isWithinRoot: (file: string) => boolean,
): Promise<string | undefined> {
	if (
		!filePath ||
		!isAbsolute(filePath) ||
		extname(filePath).toLowerCase() !== ".jsonl" ||
		!isWithinRoot(filePath)
	)
		return undefined;
	try {
		const [realRoot, realFile, info] = await Promise.all([
			realpath(rootPath),
			realpath(filePath),
			stat(filePath),
		]);
		const rel = relative(realRoot, realFile);
		if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !info.isFile())
			return undefined;
		return resolve(filePath);
	} catch {
		return undefined;
	}
}

export function validateSubagentSessionFile(
	filePath: string,
	agentDir?: string,
): Promise<string | undefined> {
	return validateSessionFile(filePath, subagentSessionsRoot(agentDir), (file) =>
		isSubagentSessionPath(file, agentDir),
	);
}

export function validateOrdinarySessionFile(
	filePath: string,
	agentDir?: string,
): Promise<string | undefined> {
	return validateSessionFile(filePath, ordinarySessionsRoot(agentDir), (file) =>
		isOrdinarySessionPath(file, agentDir),
	);
}

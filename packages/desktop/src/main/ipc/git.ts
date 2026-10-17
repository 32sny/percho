import { GIT_CHANNELS } from "@percho/shared";
import {
	getGitBlame,
	getGitDiff,
	getGitLog,
	getGitShow,
	getGitStatus,
	handleGitBranch,
	handleGitCommit,
	handleGitStash,
} from "../git";
import { registerInvokeHandlers } from "./invoke";

export function registerGitIpc(): void {
	registerInvokeHandlers(GIT_CHANNELS, {
		gitStatus: ({ cwd, path }) => getGitStatus(cwd, { path }),
		gitLog: (options) => getGitLog(options),
		gitShow: (options) => getGitShow(options),
		gitDiff: (options) => getGitDiff(options),
		gitBlame: (options) => getGitBlame(options),
		gitBranch: (options) => handleGitBranch(options),
		gitCommit: (options) => handleGitCommit(options),
		gitStash: (options) => handleGitStash(options),
	});
}

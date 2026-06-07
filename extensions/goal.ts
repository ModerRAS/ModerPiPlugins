import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const GOAL_ENTRY_TYPE = "goal-state";
const GOAL_STATUS_KEY = "goal";
const GOAL_PROMPT_HEADER = "[Persistent Goal]";
const GOAL_CONTINUE_MESSAGE_TYPE = "goal-continue";
const GOAL_REVIEW_TOOL_NAME = "goal_review";
const GOAL_WAIT_TOOL_NAME = "goal_wait_for_user";
const GOAL_REVIEW_EXTENSION_PATHS_ENV = "PI_GOAL_REVIEW_EXTENSION_PATHS";
const GOAL_REVIEW_MODEL_ENV = "PI_GOAL_REVIEW_MODEL";
const GOAL_REVIEW_TIMEOUT_MS_ENV = "PI_GOAL_REVIEW_TIMEOUT_MS";
const GOAL_REVIEWER_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
const GOAL_REVIEW_TIMEOUT_MS_DEFAULT = 5 * 60 * 1000;
const STATUS_MAX_LENGTH = 60;
const REVIEWER_SYSTEM_PROMPT = `You are an independent reviewer for a persistent coding goal.
Judge completion from the actual repository state, not the implementer's self-report.
Inspect files directly and use non-mutating bash verification when helpful.
Approve only if the current workspace already satisfies the goal well enough to stop autonomous work.
If anything material is missing, uncertain, or blocked, reject.

Return exactly one JSON object and nothing else:
{"approved":true|false,"summary":"short summary","issues":["..."],"evidence":["..."]}`;

type GoalReviewRecord = {
	approved: boolean;
	evidence: string[];
	issues: string[];
	reviewedAt: string;
	reviewerModel?: string;
	summary: string;
};

type GoalStateData = {
	active?: boolean;
	goal?: string;
	lastReview?: GoalReviewRecord;
	waitReason?: string;
	waitingForUser?: boolean;
};

type GoalSessionEntry = {
	type: string;
	customType?: string;
	data?: GoalStateData;
};

type GoalContextMessage = {
	content?: unknown;
	customType?: string;
	role?: string;
};

type RepoSnapshot = {
	branch?: string;
	cachedDiffStat?: string;
	diffStat?: string;
	gitAvailable: boolean;
	statusShort?: string;
};

type GoalReviewVerdict = GoalReviewRecord & {
	rawOutput: string;
};

type JsonModeLine = {
	message?: {
		content?: Array<{ text?: string; type?: string }>;
		model?: string;
		role?: string;
	};
	type?: string;
};

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeGoal(text: string | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed ? trimmed : undefined;
}

function normalizeStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}
	if (typeof value === "string") {
		return value
			.split(/\r?\n/)
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}
	return [];
}

function buildStatusText(goal: string | undefined, active: boolean, waitingForUser: boolean): string | undefined {
	if (!goal) return undefined;
	const prefix = waitingForUser ? "goal(waiting):" : active ? "goal:" : "goal(paused):";
	return `${prefix} ${truncateText(goal, STATUS_MAX_LENGTH)}`;
}

function buildGoalPrompt(goal: string): string {
	return `${GOAL_PROMPT_HEADER}
Current long-running goal: ${goal}

Treat this goal as the default direction for the session.
Keep making concrete progress until the repository state genuinely satisfies the goal or you are blocked.
If you need user input or a user decision before you can continue, call the ${GOAL_WAIT_TOOL_NAME} tool with a specific reason before replying to the user.
If you think the repository state now satisfies the goal, call the ${GOAL_REVIEW_TOOL_NAME} tool. The goal only ends when that independent review approves it.
Do not declare the goal complete without ${GOAL_REVIEW_TOOL_NAME} approval.
If the user explicitly asks for something unrelated, follow the latest user instruction.`;
}

function buildAutoContinueMessage(goal: string): string {
	return `Continue autonomously toward the active goal.

Goal:
${goal}

Take the next concrete step now.
Do not stop just to say you are done.
If you need user input or a user decision, call ${GOAL_WAIT_TOOL_NAME}.
If you think the repository state now satisfies the goal, call ${GOAL_REVIEW_TOOL_NAME}.`;
}

function splitCommand(args: string): { command: string; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) {
		return { command: "", rest: "" };
	}
	const spaceIndex = trimmed.indexOf(" ");
	if (spaceIndex === -1) {
		return { command: trimmed, rest: "" };
	}
	return {
		command: trimmed.slice(0, spaceIndex),
		rest: trimmed.slice(spaceIndex + 1).trim(),
	};
}

function getMessageText(message: { content?: unknown } | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") {
		return message.content.trim();
	}
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } => {
			if (!block || typeof block !== "object") return false;
			const candidate = block as { type?: string; text?: string };
			return candidate.type === "text" && typeof candidate.text === "string";
		})
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function parseDelimitedPaths(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(delimiter)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function parseTimeoutMs(value: string | undefined): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return GOAL_REVIEW_TIMEOUT_MS_DEFAULT;
	}
	return parsed;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function parseReviewVerdict(text: string, reviewerModel: string | undefined): GoalReviewVerdict {
	const trimmed = text.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
	const candidate = fenced ?? trimmed;

	const parseObject = (value: string): Record<string, unknown> | undefined => {
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
		} catch {
			return undefined;
		}
	};

	const parsed =
		parseObject(candidate) ??
		(() => {
			const start = candidate.indexOf("{");
			const end = candidate.lastIndexOf("}");
			if (start === -1 || end === -1 || end <= start) return undefined;
			return parseObject(candidate.slice(start, end + 1));
		})();

	if (!parsed) {
		return {
			approved: false,
			evidence: [],
			issues: [trimmed || "Reviewer produced no output."],
			rawOutput: text,
			reviewedAt: new Date().toISOString(),
			reviewerModel,
			summary: "Reviewer did not return valid JSON.",
		};
	}

	return {
		approved: parsed.approved === true,
		evidence: normalizeStringArray(parsed.evidence),
		issues: normalizeStringArray(parsed.issues),
		rawOutput: text,
		reviewedAt: new Date().toISOString(),
		reviewerModel,
		summary:
			normalizeGoal(typeof parsed.summary === "string" ? parsed.summary : undefined) ??
			(parsed.approved === true ? "Reviewer approved completion." : "Reviewer rejected completion."),
	};
}

function formatReviewText(review: GoalReviewVerdict): string {
	const lines = [
		review.approved ? "Independent goal review approved completion." : "Independent goal review rejected completion.",
		"",
		`Summary: ${review.summary}`,
	];
	if (review.issues.length > 0) {
		lines.push("", "Issues:");
		for (const issue of review.issues) {
			lines.push(`- ${issue}`);
		}
	}
	if (review.evidence.length > 0) {
		lines.push("", "Evidence:");
		for (const item of review.evidence) {
			lines.push(`- ${item}`);
		}
	}
	return lines.join("\n");
}

export default function goalExtension(pi: ExtensionAPI): void {
	let currentGoal: string | undefined;
	let goalActive = false;
	let waitingForUser = false;
	let waitingReason: string | undefined;
	let lastReview: GoalReviewRecord | undefined;

	function syncUi(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const statusText = buildStatusText(currentGoal, goalActive, waitingForUser);
		if (!statusText) {
			ctx.ui.setStatus(GOAL_STATUS_KEY, undefined);
			return;
		}
		const color = waitingForUser ? "warning" : goalActive ? "accent" : "muted";
		ctx.ui.setStatus(GOAL_STATUS_KEY, ctx.ui.theme.fg(color, statusText));
	}

	function reconstructState(ctx: ExtensionContext): void {
		currentGoal = undefined;
		goalActive = false;
		waitingForUser = false;
		waitingReason = undefined;
		lastReview = undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			const customEntry = entry as GoalSessionEntry;
			if (customEntry.type !== "custom" || customEntry.customType !== GOAL_ENTRY_TYPE) continue;
			const data = customEntry.data;
			currentGoal = normalizeGoal(data?.goal);
			goalActive = Boolean(data?.active && currentGoal);
			waitingForUser = Boolean(data?.waitingForUser && goalActive && currentGoal);
			waitingReason = normalizeGoal(data?.waitReason);
			lastReview = data?.lastReview;
		}

		if (!currentGoal) {
			goalActive = false;
			waitingForUser = false;
			waitingReason = undefined;
		}
		if (!waitingForUser) {
			waitingReason = undefined;
		}
	}

	function persistState(): void {
		pi.appendEntry(GOAL_ENTRY_TYPE, {
			active: goalActive && Boolean(currentGoal),
			goal: currentGoal,
			lastReview,
			waitReason: waitingForUser ? waitingReason : undefined,
			waitingForUser: waitingForUser && goalActive && Boolean(currentGoal),
		});
	}

	function showState(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!currentGoal) {
			if (lastReview?.approved) {
				ctx.ui.notify(`No active goal. Last completed review: ${lastReview.summary}`, "info");
				return;
			}
			ctx.ui.notify("No active or paused goal.", "info");
			return;
		}
		const stateLabel = waitingForUser ? "waiting for user" : goalActive ? "active" : "paused";
		const lines = [`Goal (${stateLabel}): ${currentGoal}`];
		if (waitingForUser && waitingReason) {
			lines.push(`Waiting reason: ${waitingReason}`);
		}
		if (lastReview) {
			lines.push(`Last review: ${lastReview.approved ? "approved" : "rejected"} - ${lastReview.summary}`);
		}
		ctx.ui.notify(lines.join("\n"), "info");
	}

	function sendGoalContinuation(ctx: ExtensionContext): void {
		if (!currentGoal || !goalActive || waitingForUser) return;
		pi.sendMessage(
			{
				content: buildAutoContinueMessage(currentGoal),
				customType: GOAL_CONTINUE_MESSAGE_TYPE,
				display: false,
			},
			ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp" },
		);
	}

	function queueGoalContinuation(ctx: ExtensionContext): void {
		if (!currentGoal || !goalActive || waitingForUser) return;
		sendGoalContinuation(ctx);
	}

	function setGoal(goal: string, ctx: ExtensionContext): void {
		currentGoal = normalizeGoal(goal);
		goalActive = Boolean(currentGoal);
		waitingForUser = false;
		waitingReason = undefined;
		lastReview = undefined;
		persistState();
		syncUi(ctx);
		if (ctx.hasUI && currentGoal) {
			ctx.ui.notify(`Goal set: ${truncateText(currentGoal, 100)}`, "info");
		}
		queueGoalContinuation(ctx);
	}

	function pauseGoal(ctx: ExtensionContext): void {
		if (!currentGoal) {
			if (ctx.hasUI) ctx.ui.notify("No goal to pause.", "warning");
			return;
		}
		goalActive = false;
		waitingForUser = false;
		waitingReason = undefined;
		persistState();
		syncUi(ctx);
		if (ctx.hasUI) ctx.ui.notify("Goal paused.", "info");
	}

	function resumeGoal(ctx: ExtensionContext): void {
		if (!currentGoal) {
			if (ctx.hasUI) ctx.ui.notify("No goal to resume.", "warning");
			return;
		}
		goalActive = true;
		waitingForUser = false;
		waitingReason = undefined;
		persistState();
		syncUi(ctx);
		if (ctx.hasUI) ctx.ui.notify("Goal resumed.", "info");
		queueGoalContinuation(ctx);
	}

	function clearGoal(ctx: ExtensionContext): void {
		currentGoal = undefined;
		goalActive = false;
		waitingForUser = false;
		waitingReason = undefined;
		lastReview = undefined;
		persistState();
		syncUi(ctx);
		if (ctx.hasUI) ctx.ui.notify("Goal cleared.", "info");
	}

	async function waitForGoalToSettle(ctx: {
		isIdle(): boolean;
		mode: string;
		waitForIdle(): Promise<void>;
	}): Promise<void> {
		if (ctx.mode === "tui") return;
		if (!ctx.isIdle()) {
			await ctx.waitForIdle();
		}
	}

	function completeGoalFromReview(review: GoalReviewVerdict, ctx: ExtensionContext): void {
		currentGoal = undefined;
		goalActive = false;
		waitingForUser = false;
		waitingReason = undefined;
		lastReview = {
			approved: true,
			evidence: review.evidence,
			issues: review.issues,
			reviewedAt: review.reviewedAt,
			reviewerModel: review.reviewerModel,
			summary: review.summary,
		};
		persistState();
		syncUi(ctx);
		if (ctx.hasUI) ctx.ui.notify(`Goal completed after review: ${review.summary}`, "info");
	}

	function rejectGoalReview(review: GoalReviewVerdict, ctx: ExtensionContext): void {
		lastReview = {
			approved: false,
			evidence: review.evidence,
			issues: review.issues,
			reviewedAt: review.reviewedAt,
			reviewerModel: review.reviewerModel,
			summary: review.summary,
		};
		persistState();
		syncUi(ctx);
		if (ctx.hasUI) ctx.ui.notify(`Goal review rejected: ${review.summary}`, "warning");
	}

	async function collectRepoSnapshot(cwd: string): Promise<RepoSnapshot> {
		const insideGit = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 5000 });
		if (insideGit.code !== 0 || insideGit.stdout.trim() !== "true") {
			return { gitAvailable: false };
		}

		const [branchResult, statusResult, diffStatResult, cachedDiffStatResult] = await Promise.all([
			pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 5000 }),
			pi.exec("git", ["status", "--short"], { cwd, timeout: 5000 }),
			pi.exec("git", ["diff", "--stat"], { cwd, timeout: 5000 }),
			pi.exec("git", ["diff", "--cached", "--stat"], { cwd, timeout: 5000 }),
		]);

		return {
			branch: normalizeGoal(branchResult.stdout),
			cachedDiffStat: normalizeGoal(cachedDiffStatResult.stdout),
			diffStat: normalizeGoal(diffStatResult.stdout),
			gitAvailable: true,
			statusShort: normalizeGoal(statusResult.stdout),
		};
	}

	function buildRecentConversationSummary(ctx: ExtensionContext): string {
		const lines: string[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			const record = entry as { message?: { content?: unknown; role?: string }; type?: string };
			if (record.type !== "message" || !record.message) continue;
			if (record.message.role !== "user" && record.message.role !== "assistant") continue;
			const text = getMessageText(record.message);
			if (!text) continue;
			lines.push(`${record.message.role}: ${truncateText(text, 280)}`);
		}
		return lines.slice(-8).join("\n");
	}

	function buildReviewerTask(goal: string, summary: string, snapshot: RepoSnapshot, conversationSummary: string): string {
		const sections = [
			"Review whether the current workspace genuinely satisfies the active goal.",
			"",
			`Goal:\n${goal}`,
			"",
			`Primary agent completion claim:\n${summary}`,
		];

		if (conversationSummary) {
			sections.push("", `Recent conversation context:\n${conversationSummary}`);
		}

		if (snapshot.gitAvailable) {
			sections.push(
				"",
				`Git branch: ${snapshot.branch ?? "(unknown)"}`,
				`Git status --short:\n${snapshot.statusShort ?? "(clean)"}`,
				`Git diff --stat:\n${snapshot.diffStat ?? "(no unstaged diff)"}`,
				`Git diff --cached --stat:\n${snapshot.cachedDiffStat ?? "(no staged diff)"}`,
			);
		} else {
			sections.push("", "Git snapshot: unavailable (not a git repository or git is not available).", "Inspect files directly.");
		}

		sections.push("", "Inspect the repository directly before approving.", "Return only the JSON object.");
		return sections.join("\n");
	}

	async function runReviewerSubprocess(
		goal: string,
		summary: string,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<GoalReviewVerdict> {
		const promptDir = mkdtempSync(join(tmpdir(), "pi-goal-review-"));
		const promptFile = join(promptDir, "reviewer-prompt.md");
		writeFileSync(promptFile, REVIEWER_SYSTEM_PROMPT, "utf8");

		try {
			const snapshot = await collectRepoSnapshot(ctx.cwd);
			const conversationSummary = buildRecentConversationSummary(ctx);
			const reviewerModel =
				normalizeGoal(process.env[GOAL_REVIEW_MODEL_ENV]) ??
				(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
			const args = [
				"--mode",
				"json",
				"-p",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--thinking",
				"off",
				"--tools",
				GOAL_REVIEWER_TOOLS.join(","),
				"--append-system-prompt",
				promptFile,
			];

			for (const extensionPath of parseDelimitedPaths(process.env[GOAL_REVIEW_EXTENSION_PATHS_ENV])) {
				args.push("-e", extensionPath);
			}
			if (reviewerModel) {
				args.push("--model", reviewerModel);
			}
			args.push(buildReviewerTask(goal, summary, snapshot, conversationSummary));

			const invocation = getPiInvocation(args);
			const result = await pi.exec(invocation.command, invocation.args, {
				cwd: ctx.cwd,
				signal,
				timeout: parseTimeoutMs(process.env[GOAL_REVIEW_TIMEOUT_MS_ENV]),
			});

			let finalAssistantText = "";
			let resolvedReviewerModel = reviewerModel;
			for (const line of result.stdout.split(/\r?\n/)) {
				if (!line.trim()) continue;
				let parsed: JsonModeLine | undefined;
				try {
					parsed = JSON.parse(line) as JsonModeLine;
				} catch {
					continue;
				}
				if (parsed.type !== "message_end" || parsed.message?.role !== "assistant") continue;
				finalAssistantText = getMessageText(parsed.message);
				if (parsed.message.model) {
					resolvedReviewerModel = parsed.message.model;
				}
			}

			if (result.code !== 0) {
				return {
					approved: false,
					evidence: [],
					issues: [result.stderr.trim() || `Reviewer subprocess exited with code ${result.code}.`],
					rawOutput: finalAssistantText,
					reviewedAt: new Date().toISOString(),
					reviewerModel: resolvedReviewerModel,
					summary: "Reviewer subprocess failed.",
				};
			}

			const verdict = parseReviewVerdict(finalAssistantText, resolvedReviewerModel);
			if (result.stderr.trim()) {
				verdict.evidence = [...verdict.evidence, `stderr: ${truncateText(result.stderr.trim(), 500)}`];
			}
			return verdict;
		} finally {
			rmSync(promptDir, { force: true, recursive: true });
		}
	}

	pi.registerTool({
		description:
			"Run an independent code-based review of the active long-running goal. Use when you think the repository state already satisfies the goal. The goal only ends if this review approves it.",
		label: "Goal Review",
		name: GOAL_REVIEW_TOOL_NAME,
		parameters: Type.Object({
			summary: Type.String({
				description: "Concrete summary of what changed and why the active goal should now be considered complete.",
			}),
		}),
		promptGuidelines: [
			`Do not declare the active goal complete without calling ${GOAL_REVIEW_TOOL_NAME}.`,
			`If ${GOAL_REVIEW_TOOL_NAME} rejects completion, keep working on the reported issues before trying again.`,
		],
		promptSnippet: `${GOAL_REVIEW_TOOL_NAME}({ summary }) - ask an independent reviewer to inspect the actual repository state before ending the active goal.`,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!currentGoal || !goalActive) {
				return {
					content: [{ type: "text", text: "No active goal is available for review." }],
					details: { approved: false, status: "no_active_goal" },
					isError: true,
				};
			}

			onUpdate?.({ content: [{ type: "text", text: "Running independent goal review..." }], details: {} });
			const review = await runReviewerSubprocess(currentGoal, normalizeGoal(params.summary) ?? params.summary, ctx, signal);

			if (review.approved) {
				completeGoalFromReview(review, ctx);
				return {
					content: [{ type: "text", text: formatReviewText(review) }],
					details: review,
				};
			}

			rejectGoalReview(review, ctx);
			return {
				content: [{ type: "text", text: formatReviewText(review) }],
				details: review,
			};
		},
	});

	pi.registerTool({
		description:
			"Pause automatic goal continuation because the user must answer a question or make a decision before work can continue.",
		label: "Goal Wait For User",
		name: GOAL_WAIT_TOOL_NAME,
		parameters: Type.Object({
			reason: Type.String({
				description: "The exact user input, decision, approval, or missing information needed before the goal can continue.",
			}),
		}),
		promptGuidelines: [
			`If you need user input before you can continue the active goal, call ${GOAL_WAIT_TOOL_NAME} before replying.`,
		],
		promptSnippet: `${GOAL_WAIT_TOOL_NAME}({ reason }) - pause automatic goal continuation until the user replies.`,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!currentGoal || !goalActive) {
				return {
					content: [{ type: "text", text: "No active goal is currently running." }],
					details: { waitingForUser: false },
				};
			}

			waitingForUser = true;
			waitingReason = normalizeGoal(params.reason) ?? params.reason;
			persistState();
			syncUi(ctx);
			if (ctx.hasUI) {
				ctx.ui.notify(`Goal paused for user input: ${truncateText(waitingReason, 120)}`, "warning");
			}
			return {
				content: [
					{
						type: "text",
						text: `Automatic goal continuation is now paused until the user replies. Missing input: ${waitingReason}`,
					},
				],
				details: { reason: waitingReason, waitingForUser: true },
			};
		},
	});

	pi.registerCommand("goal", {
		description: "Show or manage the persistent session goal",
		getArgumentCompletions: (prefix) => {
			const options = ["pause", "resume", "clear", "set "]
				.filter((option) => option.startsWith(prefix))
				.map((option) => ({ value: option, label: option.trim() || option }));
			return options.length > 0 ? options : null;
		},
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			if (!trimmedArgs) {
				showState(ctx);
				return;
			}

			const { command, rest } = splitCommand(trimmedArgs);
			if (command === "pause" && !rest) {
				pauseGoal(ctx);
				return;
			}
			if (command === "resume" && !rest) {
				resumeGoal(ctx);
				await waitForGoalToSettle(ctx);
				return;
			}
			if (command === "clear" && !rest) {
				clearGoal(ctx);
				return;
			}
			if (command === "set") {
				const goal = normalizeGoal(rest);
				if (!goal) {
					if (ctx.hasUI) ctx.ui.notify("Usage: /goal set <goal>", "warning");
					return;
				}
				setGoal(goal, ctx);
				await waitForGoalToSettle(ctx);
				return;
			}
			setGoal(trimmedArgs, ctx);
			await waitForGoalToSettle(ctx);
		},
	});

	pi.on("context", async (event) => {
		let latestGoalContinueIndex = -1;
		for (let index = event.messages.length - 1; index >= 0; index--) {
			const candidate = event.messages[index] as GoalContextMessage;
			if (candidate.role === "custom" && candidate.customType === GOAL_CONTINUE_MESSAGE_TYPE) {
				latestGoalContinueIndex = index;
				break;
			}
		}

		const filteredMessages = event.messages.filter((message, index) => {
			const candidate = message as GoalContextMessage;
			if (candidate.role === "custom" && candidate.customType === GOAL_CONTINUE_MESSAGE_TYPE) {
				return index === latestGoalContinueIndex;
			}
			return true;
		});
		if (filteredMessages.length !== event.messages.length) {
			return { messages: filteredMessages };
		}
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;
		if (!currentGoal || !goalActive || !waitingForUser) return;
		waitingForUser = false;
		waitingReason = undefined;
		persistState();
		syncUi(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify("Goal resumed after user input.", "info");
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!goalActive || !currentGoal) return;
		const goalPrompt = buildGoalPrompt(currentGoal);
		if (event.systemPrompt.includes(goalPrompt)) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${goalPrompt}` };
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!goalActive || !currentGoal || waitingForUser) return;
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason !== "stop") return;
		queueGoalContinuation(ctx);
	});

	pi.on("session_start", async (event, ctx) => {
		reconstructState(ctx);
		syncUi(ctx);
		if (ctx.mode === "tui" && event.reason !== "reload" && currentGoal && goalActive && !waitingForUser) {
			queueGoalContinuation(ctx);
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		syncUi(ctx);
	});
}

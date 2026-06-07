import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const GOAL_ENTRY_TYPE = "goal-state";
const GOAL_STATUS_KEY = "goal";
const GOAL_PROMPT_HEADER = "[Persistent Goal]";
const STATUS_MAX_LENGTH = 60;

type GoalStateData = {
	active?: boolean;
	goal?: string;
};

type GoalSessionEntry = {
	type: string;
	customType?: string;
	data?: GoalStateData;
};

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeGoal(text: string | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed ? trimmed : undefined;
}

function buildStatusText(goal: string | undefined, active: boolean): string | undefined {
	if (!goal) return undefined;
	const prefix = active ? "goal:" : "goal(paused):";
	return `${prefix} ${truncateText(goal, STATUS_MAX_LENGTH)}`;
}

function buildGoalPrompt(goal: string): string {
	return `${GOAL_PROMPT_HEADER}
Current long-running goal: ${goal}

Treat this goal as the default direction for the session.
Prefer work that advances it.
If the user explicitly asks for something unrelated, follow the latest user instruction, but stay aware of the goal and call out if priorities appear to shift.`;
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

export default function goalExtension(pi: ExtensionAPI): void {
	let currentGoal: string | undefined;
	let goalActive = false;

	function forcePersistSessionState(ctx: ExtensionContext): void {
		const sessionFile = ctx.sessionManager.getSessionFile();
		const header = ctx.sessionManager.getHeader();
		if (!sessionFile || !header) return;

		const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & { flushed?: boolean };
		if (existsSync(sessionFile)) {
			sessionManager.flushed = true;
			return;
		}

		mkdirSync(dirname(sessionFile), { recursive: true });
		const entries = [header, ...ctx.sessionManager.getEntries()];
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
		sessionManager.flushed = true;
	}

	function syncUi(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const statusText = buildStatusText(currentGoal, goalActive);
		if (!statusText) {
			ctx.ui.setStatus(GOAL_STATUS_KEY, undefined);
			return;
		}
		const color = goalActive ? "accent" : "muted";
		ctx.ui.setStatus(GOAL_STATUS_KEY, ctx.ui.theme.fg(color, statusText));
	}

	function reconstructState(ctx: ExtensionContext): void {
		currentGoal = undefined;
		goalActive = false;

		for (const entry of ctx.sessionManager.getBranch()) {
			const customEntry = entry as GoalSessionEntry;
			if (customEntry.type !== "custom" || customEntry.customType !== GOAL_ENTRY_TYPE) continue;
			currentGoal = normalizeGoal(customEntry.data?.goal);
			goalActive = Boolean(customEntry.data?.active && currentGoal);
		}
	}

	function persistState(ctx: ExtensionContext): void {
		pi.appendEntry(GOAL_ENTRY_TYPE, {
			goal: currentGoal,
			active: goalActive && Boolean(currentGoal),
		});
		forcePersistSessionState(ctx);
	}

	function showState(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!currentGoal) {
			ctx.ui.notify("No active or paused goal.", "info");
			return;
		}
		const stateLabel = goalActive ? "active" : "paused";
		ctx.ui.notify(`Goal (${stateLabel}): ${currentGoal}`, "info");
	}

	function setGoal(goal: string, ctx: ExtensionContext): void {
		currentGoal = normalizeGoal(goal);
		goalActive = Boolean(currentGoal);
		persistState(ctx);
		syncUi(ctx);
		if (ctx.hasUI && currentGoal) {
			ctx.ui.notify(`Goal set: ${truncateText(currentGoal, 100)}`, "info");
		}
	}

	function pauseGoal(ctx: ExtensionContext): void {
		if (!currentGoal) {
			if (ctx.hasUI) ctx.ui.notify("No goal to pause.", "warning");
			return;
		}
		goalActive = false;
		persistState(ctx);
		syncUi(ctx);
		if (ctx.hasUI) ctx.ui.notify("Goal paused.", "info");
	}

	function resumeGoal(ctx: ExtensionContext): void {
		if (!currentGoal) {
			if (ctx.hasUI) ctx.ui.notify("No goal to resume.", "warning");
			return;
		}
		goalActive = true;
		persistState(ctx);
		syncUi(ctx);
		if (ctx.hasUI) ctx.ui.notify("Goal resumed.", "info");
	}

	function clearGoal(ctx: ExtensionContext): void {
		currentGoal = undefined;
		goalActive = false;
		persistState(ctx);
		syncUi(ctx);
		if (ctx.hasUI) ctx.ui.notify("Goal cleared.", "info");
	}

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
				return;
			}
			setGoal(trimmedArgs, ctx);
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!goalActive || !currentGoal) return;
		const goalPrompt = buildGoalPrompt(currentGoal);
		if (event.systemPrompt.includes(goalPrompt)) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${goalPrompt}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		syncUi(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		syncUi(ctx);
	});
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { createProcessJob, type ProcessJob } from "./windows-job.ts";
import {
	MAX_CHILDREN,
	TEAM_EVENT_ENTRY,
	TEAM_INSTANCE_FLAG,
	TEAM_STATE_ENTRY,
	formatProgress,
	getMessageText,
	readInstanceConfig,
	readJsonFile,
	readJsonLines,
	registerRoleExtension,
	sendRpcPrompt,
	writeJsonAtomic,
	type AgentRecord,
	type AgentStatus,
	type TeamEvent,
	type TeamInstanceConfig,
	type TeamRole,
	type TeamSnapshot,
} from "./shared.ts";

const MAX_BOSSES = 3;
const TEAM_STATUS_KEY = "pi-team";
const TEAM_WIDGET_KEY = "pi-team-agents";
const RECOVERY_LIMIT = 3;
const ROLE_NAMES: Record<TeamRole, string> = { boss: "Boss", lead: "Lead", worker: "Worker" };
const ROLE_PROMPTS: Record<TeamRole, string> = {
	boss: `You are a Boss in a Pi coding team. You are a strictly event-driven coordinator and decision-maker, not a project implementer. For substantive project work, do not edit files, run implementation commands, or carry out the task yourself. Inspect only enough to scope and verify, then reuse or create the minimum sufficient Department Leads: one coherent workstream normally needs one Lead; add Leads only for genuinely independent domains. Act only on the current user message or a new Lead report. Handle that event by deciding, delegating, verifying, or reporting, then stop and remain idle until another external event arrives. Never invent follow-up work or keep working merely to stay busy. Team capacity is a safety ceiling, never a target. Before adding another Lead, call team_list and explain why existing Leads cannot own the work. Trivial questions, status checks, and Team control commands may be answered directly without delegation.`,
	lead: `You are a Department Lead in a Pi coding team. You are an event-driven coordinator and reviewer, not a project implementer. For substantive execution, do not edit files or carry out Worker tasks yourself. On a Boss assignment, scope it, reuse or create the minimum useful Workers, send concrete tasks, then stop and remain idle. One coherent execution task normally needs one Worker; add Workers only for genuinely independent parallel work. Worker progress, settled/idle, crash, and recovery reports will wake you. On those events, inspect the report, intervene only when correction or unblocking is needed, summarize meaningful completion or risk to your Boss, then stop and idle again. Do not create routine follow-up work merely to stay active. Team capacity is a safety ceiling, never a target. Before adding another Worker, call team_list and explain why existing Workers cannot handle it.`,
	worker: `You are a Worker in a Pi coding team. Execute the concrete task assigned to you using the full Pi tool environment. You receive only task-relevant messages. Explain your next actions and findings normally; your text is visible to your Department Lead and the user. Ask your Lead when blocked. You cannot create other agents.`,
};

interface PersistedState extends TeamSnapshot {
	version: 1;
}

interface TeamStateEntry {
	customType?: string;
	data?: PersistedState;
	type: string;
}

interface TeamEventEntry {
	customType?: string;
	data?: TeamEvent;
	type: string;
}

interface RpcResponse {
	command: string;
	data?: any;
	error?: string;
	id?: string;
	success: boolean;
	type: "response";
}

interface RuntimeAgent extends AgentRecord {
	configPath: string;
	details: string[];
	intentionalStop: boolean;
	pendingParentMessages: string[];
	progressTimer?: ReturnType<typeof setTimeout>;
	process?: ChildProcessWithoutNullStreams;
	recoveryAttempts: number;
	rpc?: RpcClient;
	token: string;
}

function truncate(text: string, max = 100): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function now(): string {
	return new Date().toISOString();
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: process.platform === "win32" ? "pi.cmd" : "pi", args };
}

class RpcClient {
	private buffer = "";
	private decoder = new StringDecoder("utf8");
	private nextId = 1;
	private pending = new Map<string, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

	constructor(
		private process: ChildProcessWithoutNullStreams,
		private onEvent: (event: any) => void,
		private onProtocolError: (line: string) => void,
	) {
		process.stdout.on("data", (chunk) => this.consume(chunk));
		process.stdout.on("end", () => {
			this.buffer += this.decoder.end();
			if (this.buffer.trim()) this.processLine(this.buffer);
		});
	}

	private consume(chunk: Buffer): void {
		this.buffer += this.decoder.write(chunk);
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.processLine(line);
		}
	}

	private processLine(line: string): void {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			this.onProtocolError(line);
			return;
		}
		if (event.type === "response" && event.id && this.pending.has(event.id)) {
			const pending = this.pending.get(event.id)!;
			clearTimeout(pending.timer);
			this.pending.delete(event.id);
			if (event.success) pending.resolve(event as RpcResponse);
			else pending.reject(new Error(event.error || `RPC ${event.command} failed`));
			return;
		}
		this.onEvent(event);
	}

	request(command: Record<string, unknown>, timeoutMs = 15_000): Promise<RpcResponse> {
		const id = `team-${this.nextId++}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC command ${String(command.type)} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}

export class TeamActivityPanel {
	constructor(
		private tui: TUI,
		private getAgents: () => RuntimeAgent[],
		private getFocusedBoss: () => string | undefined,
		private getInspectedAgent: () => RuntimeAgent | undefined,
	) {}

	render(width: number): string[] {
		if (width < 2) return [" ".repeat(Math.max(0, width))];
		const inner = width - 2;
		const frameLine = (line: string): string => {
			const clipped = truncateToWidth(line, inner, "…");
			return `│${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}│`;
		};
		const allAgents = this.getAgents();
		const byId = new Map(allAgents.map((agent) => [agent.agentId, agent]));
		const pathOf = (agentId: string): string => {
			const parts: string[] = [];
			let current = byId.get(agentId);
			while (current) {
				parts.unshift(current.agentId);
				current = current.parentId ? byId.get(current.parentId) : undefined;
			}
			return parts.length ? parts.join("/") : agentId;
		};
		const inspected = this.getInspectedAgent();
		if (inspected) {
			const lines = [
				`INSPECT ${pathOf(inspected.agentId)}`,
				`[${inspected.role}/${inspected.status}]`,
				"",
				...inspected.details.slice(-30),
			];
			return [
				`┌${"─".repeat(inner)}┐`,
				...lines.map(frameLine),
				`└${"─".repeat(inner)}┘`,
			];
		}
		const agentLines = allAgents.slice(0, 12).map((agent) => {
			const focus = agent.agentId === this.getFocusedBoss() ? ">" : " ";
			return `${focus} ${pathOf(agent.agentId)} [${agent.role}/${agent.status} r${agent.runCount ?? 0}]`;
		});
		const lines = ["PI TEAM", ...(agentLines.length ? agentLines : ["No active agents"])];
		return [
			`┌${"─".repeat(inner)}┐`,
			...lines.map(frameLine),
			`└${"─".repeat(inner)}┘`,
		];
	}

	requestRender(): void {
		this.tui.requestRender();
	}

	handleInput(): void {}
	invalidate(): void {}
}

export default function piTeamExtension(pi: ExtensionAPI): void {
	pi.registerFlag(TEAM_INSTANCE_FLAG, { type: "string", description: "Internal Pi Team role instance config" });
	const instance = readInstanceConfig(pi);
	if (instance) {
		registerRoleExtension(pi, instance.role);
		pi.on("before_agent_start", async (event) => ({
			systemPrompt: `${event.systemPrompt}\n\n${ROLE_PROMPTS[instance.role]}\n\nAgent ID: ${instance.agentId}\nTask: ${instance.task}\nUse team tools for delegation, directed communication, cancellation, and reading the formal group chat.`,
		}));
		return;
	}

	let context: ExtensionContext | undefined;
	let teamId = randomUUID();
	let focusedBossId: string | undefined;
	let seq = 0;
	let shuttingDown = false;
	let server: ReturnType<typeof createServer> | undefined;
	let startupPromise: Promise<void> | undefined;
	let processJob: ProcessJob | undefined;
	let serverUrl = "";
	let stateRoot = "";
	let stateDir = "";
	let statePath = "";
	let eventsPath = "";
	let teamSessionMirror: SessionManager | undefined;
	let inspectedAgentId: string | undefined;
	let activityPanel: TeamActivityPanel | undefined;
	const agents = new Map<string, RuntimeAgent>();
	const events: TeamEvent[] = [];
	const parentNotifications = new Map<string, { messages: string[]; timer?: ReturnType<typeof setTimeout> }>();
	const extensionPath = fileURLToPath(import.meta.url);

	function agentPath(agentId: string): string {
		const parts: string[] = [];
		let current = agents.get(agentId);
		while (current) {
			parts.unshift(current.agentId);
			current = current.parentId ? agents.get(current.parentId) : undefined;
		}
		return parts.length ? parts.join("/") : agentId;
	}

	function resolveAgent(reference: string, rejectAmbiguousName = false): RuntimeAgent | undefined {
		const normalized = reference.trim().replace(/^@/, "");
		const addressed = agents.get(normalized) ?? [...agents.values()].find((agent) => agentPath(agent.agentId) === normalized);
		if (addressed) return addressed;
		const named = [...agents.values()].filter((agent) => agent.name === normalized);
		if (named.length === 1) return named[0];
		if (named.length > 1 && rejectAmbiguousName) throw new Error(`Ambiguous target name: ${normalized}; use an agent ID or full path`);
		return undefined;
	}

	function publicAgent(agent: RuntimeAgent): AgentRecord {
		const { configPath: _configPath, details: _details, intentionalStop: _intentionalStop, pendingParentMessages: _pendingParentMessages, progressTimer: _progressTimer, process: _process, recoveryAttempts: _recoveryAttempts, rpc: _rpc, token: _token, ...record } = agent;
		return { ...record, path: agentPath(agent.agentId) };
	}

	function snapshot(): PersistedState {
		return { version: 1, teamId, focusedBossId, agents: [...agents.values()].map(publicAgent) };
	}

	function teamSessionName(): string {
		const boss = [...agents.values()].find((agent) => agent.role === "boss");
		return boss ? `Pi Team: ${truncate(boss.task, 60)}` : "Pi Team";
	}

	function mainSessionPersists(): boolean {
		return Boolean(context?.sessionManager.getSessionFile());
	}

	function ensureTeamSessionMirror(): SessionManager | undefined {
		if (!context || mainSessionPersists()) return undefined;
		if (!teamSessionMirror) {
			teamSessionMirror = SessionManager.create(context.cwd);
			teamSessionMirror.appendSessionInfo(teamSessionName());
			teamSessionMirror.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Pi Team supervisor session. Resume this session to restore the team, focused Boss, and formal group chat." }],
				api: "openai-responses",
				provider: "pi-team",
				model: "supervisor",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			const persistedEvents = eventsPath ? readJsonLines<TeamEvent>(eventsPath) : events;
			for (const event of persistedEvents) teamSessionMirror.appendCustomEntry(TEAM_EVENT_ENTRY, event);
		}
		return teamSessionMirror;
	}

	function persistState(): void {
		const state = snapshot();
		pi.appendEntry<PersistedState>(TEAM_STATE_ENTRY, state);
		ensureTeamSessionMirror()?.appendCustomEntry(TEAM_STATE_ENTRY, state);
		if (statePath) writeJsonAtomic(statePath, state);
		if (stateRoot && stateDir) writeJsonAtomic(join(stateRoot, "latest.json"), { storageId: basename(stateDir), updatedAt: now(), version: 1 });
	}

	function appendEvent(input: Omit<TeamEvent, "eventId" | "seq" | "timestamp">): TeamEvent {
		const event: TeamEvent = { ...input, eventId: randomUUID(), seq: ++seq, timestamp: now() };
		events.push(event);
		if (events.length > 1000) events.splice(0, events.length - 1000);
		if (eventsPath) appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
		pi.appendEntry<TeamEvent>(TEAM_EVENT_ENTRY, event);
		const existingMirror = teamSessionMirror;
		const mirror = ensureTeamSessionMirror();
		if (mirror && existingMirror) mirror.appendCustomEntry(TEAM_EVENT_ENTRY, event);
		return event;
	}

	function isMainTranscriptEvent(event: TeamEvent): boolean {
		return event.kind === "message";
	}

	function updateUi(): void {
		if (!context?.hasUI) return;
		const list = [...agents.values()];
		context.ui.setStatus(TEAM_STATUS_KEY, `team ${list.filter((a) => a.status === "running").length}/${list.length}`);
		if (context.mode === "tui") {
			if (!activityPanel) {
				context.ui.setWidget(TEAM_WIDGET_KEY, (tui) => {
					activityPanel = new TeamActivityPanel(
						tui,
						() => [...agents.values()],
						() => focusedBossId,
						() => inspectedAgentId ? agents.get(inspectedAgentId) : undefined,
					);
					return activityPanel;
				}, { placement: "belowEditor" });
			} else {
				activityPanel.requestRender();
			}
			return;
		}
		const lines = list.slice(0, 12).map((agent) => {
			const focus = agent.agentId === focusedBossId ? ">" : " ";
			return `${focus} ${agentPath(agent.agentId)} [${agent.role}/${agent.status} r${agent.runCount ?? 0}] ${truncate(agent.task, 55)}`;
		});
		context.ui.setWidget(TEAM_WIDGET_KEY, lines.length ? lines : ["Pi Team: /boss <task> to start"], { placement: "belowEditor" });
	}

	function readStandaloneState(directory: string): PersistedState | undefined {
		const stored = readJsonFile<PersistedState>(join(directory, "state.json"));
		if (stored?.version === 1 && Array.isArray(stored.agents)) return stored;

		const agentsDirectory = join(directory, "agents");
		if (!existsSync(agentsDirectory)) return undefined;
		const storedEvents = readJsonLines<TeamEvent>(join(directory, "events.jsonl"));
		const cancelled = new Set(storedEvents.filter((event) => event.kind === "control" && event.content.startsWith("Cancelled ")).flatMap((event) => event.targetIds));
		const records: AgentRecord[] = [];
		let legacyTeamId: string | undefined;
		for (const entry of readdirSync(agentsDirectory, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const config = readJsonFile<TeamInstanceConfig>(join(agentsDirectory, entry.name, "instance.json"));
			if (!config?.agentId || !config.task || !(["boss", "lead", "worker"] as const).includes(config.role)) continue;
			legacyTeamId ??= config.teamId;
			const sessionsDirectory = join(agentsDirectory, entry.name, "sessions");
			const sessionPath = existsSync(sessionsDirectory)
				? readdirSync(sessionsDirectory)
					.filter((name) => name.endsWith(".jsonl"))
					.map((name) => join(sessionsDirectory, name))
					.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0]
				: undefined;
			records.push({
				actorEpoch: config.actorEpoch,
				agentId: config.agentId,
				departmentId: config.departmentId,
				name: config.agentId,
				parentId: config.parentId,
				role: config.role,
				runCount: 0,
				sessionPath,
				status: cancelled.has(config.agentId) ? "cancelled" : "recovering",
				task: config.task,
			});
		}
		if (!legacyTeamId || !records.length) return undefined;
		return { version: 1, teamId: legacyTeamId, focusedBossId: records.find((agent) => agent.role === "boss")?.agentId, agents: records };
	}

	function findStandaloneState(root: string): { directory: string; state: PersistedState } | undefined {
		const pointer = readJsonFile<{ storageId?: string }>(join(root, "latest.json"));
		const pointedDirectory = pointer?.storageId && basename(pointer.storageId) === pointer.storageId ? join(root, pointer.storageId) : undefined;
		const directories = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(root, entry.name))
			.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
		const candidates = pointedDirectory ? [pointedDirectory, ...directories.filter((directory) => directory !== pointedDirectory)] : directories;
		for (const directory of candidates) {
			const state = readStandaloneState(directory);
			if (state) return { directory, state };
		}
		return undefined;
	}

	function reconstruct(ctx: ExtensionContext, reason: string): void {
		context = ctx;
		teamSessionMirror = undefined;
		for (const batch of parentNotifications.values()) if (batch.timer) clearTimeout(batch.timer);
		parentNotifications.clear();
		agents.clear();
		events.length = 0;
		seq = 0;
		let saved: PersistedState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			const stateEntry = entry as TeamStateEntry;
			if (stateEntry.type === "custom" && stateEntry.customType === TEAM_STATE_ENTRY && stateEntry.data) saved = stateEntry.data;
			const eventEntry = entry as TeamEventEntry;
			if (eventEntry.type === "custom" && eventEntry.customType === TEAM_EVENT_ENTRY && eventEntry.data) events.push(eventEntry.data);
		}

		stateRoot = join(ctx.cwd, CONFIG_DIR_NAME, "pi-team");
		mkdirSync(stateRoot, { recursive: true });
		stateDir = join(stateRoot, ctx.sessionManager.getSessionId());
		if (!saved && !mainSessionPersists() && reason !== "new" && reason !== "fork") {
			const standalone = findStandaloneState(stateRoot);
			if (standalone) {
				saved = standalone.state;
				stateDir = standalone.directory;
			}
		}
		mkdirSync(stateDir, { recursive: true });
		statePath = join(stateDir, "state.json");
		eventsPath = join(stateDir, "events.jsonl");
		const mergedEvents = new Map<string, TeamEvent>();
		for (const event of [...readJsonLines<TeamEvent>(eventsPath), ...events]) {
			if (!event?.eventId || !Number.isFinite(event.seq)) continue;
			mergedEvents.set(event.eventId, event);
		}
		events.length = 0;
		events.push(...[...mergedEvents.values()].sort((left, right) => left.seq - right.seq).slice(-1000));
		seq = events.reduce((maximum, event) => Math.max(maximum, event.seq), 0);
		if (!existsSync(eventsPath) && events.length) writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

		if (saved && reason !== "new") {
			teamId = reason === "fork" ? randomUUID() : saved.teamId;
			focusedBossId = saved.focusedBossId;
			for (const record of saved.agents) {
				agents.set(record.agentId, {
					...record,
					actorEpoch: randomUUID(),
					configPath: "",
					details: [],
					intentionalStop: false,
					pendingParentMessages: [],
					process: undefined,
					recoveryAttempts: 0,
					rpc: undefined,
					runCount: record.runCount ?? 0,
					status: record.status === "cancelled" ? "cancelled" : "recovering",
					token: randomBytes(24).toString("hex"),
				});
			}
			pi.setSessionName(teamSessionName());
			persistState();
		} else {
			teamId = randomUUID();
			focusedBossId = undefined;
		}
		updateUi();
	}

	function roleVisibleEvents(agent: Pick<RuntimeAgent, "agentId" | "role" | "departmentId">, drillDown = false): TeamEvent[] {
		if (agent.role === "boss") {
			const directLeadIds = new Set([...agents.values()].filter((child) => child.parentId === agent.agentId).map((child) => child.agentId));
			if (!drillDown) {
				return events.filter((event) => event.actorId === "user" || event.actorId === agent.agentId || directLeadIds.has(event.actorId) || event.targetIds.includes(agent.agentId));
			}
			const scope = new Set([agent.agentId, ...descendants(agent.agentId).map((child) => child.agentId)]);
			return events.filter((event) => scope.has(event.actorId) || event.targetIds.some((target) => scope.has(target)));
		}
		if (agent.role === "lead") return events.filter((event) => event.departmentId === agent.departmentId || event.targetIds.includes(agent.agentId));
		return events.filter((event) => event.targetIds.includes(agent.agentId));
	}

	function buildInitialPrompt(agent: RuntimeAgent, recovering: boolean): string {
		return recovering
			? `Your Pi Team process was restarted unexpectedly. Continue the same task after checking the current session and workspace state. Do not blindly repeat side effects.\n\nTask: ${agent.task}`
			: `Begin your assigned Pi Team role now.\n\nTask: ${agent.task}`;
	}

	function addDetail(agent: RuntimeAgent, line: string): void {
		agent.details.push(`${new Date().toLocaleTimeString()} ${line}`);
		if (agent.details.length > 500) agent.details.splice(0, agent.details.length - 500);
		updateUi();
	}

	function parentOf(agent: RuntimeAgent): RuntimeAgent | undefined {
		return agent.parentId ? agents.get(agent.parentId) : undefined;
	}

	async function deliver(agent: RuntimeAgent, message: string): Promise<void> {
		if (!agent.rpc) throw new Error(`${agent.agentId} is not connected`);
		const pendingBatch = parentNotifications.get(agent.agentId);
		if (pendingBatch) {
			if (pendingBatch.timer) clearTimeout(pendingBatch.timer);
			parentNotifications.delete(agent.agentId);
			message = [...pendingBatch.messages, message].join("\n\n---\n\n");
		}
		const throughSeq = seq;
		const unseen = roleVisibleEvents(agent)
			.filter((event) => event.seq > (agent.lastContextSeq ?? 0) && event.actorId !== agent.agentId)
			.map((event) => `#${event.seq} ${agentPath(event.actorId)} [${event.kind}]: ${event.content}`)
			.join("\n");
		const enriched = unseen ? `Formal Team events since your previous wake:\n${unseen}\n\nIncoming wake signal:\n${message}` : message;
		await sendRpcPrompt(agent.rpc, enriched);
		agent.lastContextSeq = Math.max(agent.lastContextSeq ?? 0, throughSeq);
		persistState();
	}

	async function publishAssistantText(agent: RuntimeAgent, text: string): Promise<void> {
		if (!text) return;
		agent.pendingParentMessages.push(text);
		appendEvent({ actorId: agent.agentId, content: text, departmentId: agent.departmentId, kind: "message", targetIds: agent.parentId ? [agent.parentId] : [] });
	}

	function scheduleWorkerInspection(agent: RuntimeAgent): void {
		if (agent.role !== "worker" || agent.progressTimer || agent.status !== "running") return;
		agent.progressTimer = setTimeout(() => {
			agent.progressTimer = undefined;
			if (agent.status !== "running") return;
			const progress = formatProgress(agent.pendingParentMessages);
			agent.pendingParentMessages.length = 0;
			appendEvent({
				actorId: "supervisor",
				content: `${agentPath(agent.agentId)} is still running at the 10-minute inspection`,
				departmentId: agent.departmentId,
				kind: "status",
				targetIds: agent.parentId ? [agent.parentId] : [],
			});
			void notifyParent(agent, `[${agentPath(agent.agentId)} worker 10-minute inspection}]\n${progress || "Still running; no new assistant text in this interval."}`);
			scheduleWorkerInspection(agent);
		}, 10 * 60_000);
	}

	async function notifyParent(agent: RuntimeAgent, message: string): Promise<void> {
		const parent = parentOf(agent);
		if (!parent || parent.status === "cancelled") return;
		let batch = parentNotifications.get(parent.agentId);
		if (!batch) {
			batch = { messages: [] };
			parentNotifications.set(parent.agentId, batch);
		}
		batch.messages.push(message);
		if (batch.timer) clearTimeout(batch.timer);
		batch.timer = setTimeout(() => {
			const current = parentNotifications.get(parent.agentId);
			if (!current) return;
			parentNotifications.delete(parent.agentId);
			if (parent.status === "cancelled") return;
			const combined = current.messages.join("\n\n---\n\n");
			deliver(parent, combined).catch((error) => {
				addDetail(parent, `delivery failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, 1_500);
	}

	function onRpcEvent(agent: RuntimeAgent, event: any): void {
		switch (event.type) {
			case "agent_start":
				agent.status = "running";
				agent.runCount = (agent.runCount ?? 0) + 1;
				scheduleWorkerInspection(agent);
				persistState();
				addDetail(agent, "agent started");
				break;
			case "agent_settled": {
				agent.status = "idle";
				if (agent.progressTimer) clearTimeout(agent.progressTimer);
				agent.progressTimer = undefined;
				addDetail(agent, "agent settled");
				persistState();
				const report = formatProgress(agent.pendingParentMessages);
				agent.pendingParentMessages.length = 0;
				appendEvent({
					actorId: "supervisor",
					content: `${agentPath(agent.agentId)} settled and is idle`,
					departmentId: agent.departmentId,
					kind: "status",
					targetIds: agent.parentId ? [agent.parentId] : [],
				});
				void notifyParent(agent, `[${agentPath(agent.agentId)} ${agent.role} settled/idle}]${report ? `\n${report}` : "\nNo new assistant text since the previous inspection."}`);
				break;
			}
			case "message_end":
				if (event.message?.role === "assistant") void publishAssistantText(agent, getMessageText(event.message));
				break;
			case "tool_execution_start":
				addDetail(agent, `tool ${event.toolName} started`);
				break;
			case "tool_execution_update":
				addDetail(agent, `tool ${event.toolName} updating`);
				break;
			case "tool_execution_end":
				addDetail(agent, `tool ${event.toolName} ${event.isError ? "failed" : "done"}`);
				break;
			case "queue_update":
				addDetail(agent, `queue steer=${event.steering?.length ?? 0} follow=${event.followUp?.length ?? 0}`);
				break;
			case "extension_ui_request":
				addDetail(agent, `UI request ${event.method}`);
				if (["select", "input", "editor", "confirm"].includes(event.method)) {
					agent.process?.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
				}
				break;
		}
		updateUi();
	}

	async function waitForReady(agent: RuntimeAgent): Promise<void> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 30; attempt++) {
			try {
				const response = await agent.rpc!.request({ type: "get_state" }, 1000);
				agent.sessionPath = response.data?.sessionFile || agent.sessionPath;
				persistState();
				return;
			} catch (error) {
				lastError = error;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		throw lastError instanceof Error ? lastError : new Error("RPC child did not become ready");
	}

	async function startAgent(agent: RuntimeAgent, recovering = false): Promise<void> {
		if (!serverUrl) throw new Error("Pi Team Supervisor is not ready");
		mkdirSync(join(stateDir, "agents", agent.agentId), { recursive: true });
		const config: TeamInstanceConfig = {
			actorEpoch: agent.actorEpoch,
			agentId: agent.agentId,
			departmentId: agent.departmentId,
			parentId: agent.parentId,
			role: agent.role,
			serverUrl,
			task: agent.task,
			teamId,
			token: agent.token,
		};
		agent.configPath = join(stateDir, "agents", agent.agentId, "instance.json");
		writeFileSync(agent.configPath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });

		const sessionDir = join(stateDir, "agents", agent.agentId, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const args = ["--mode", "rpc", "--name", `${agent.agentId}: ${truncate(agent.task, 50)}`, "--extension", extensionPath, `--${TEAM_INSTANCE_FLAG}`, agent.configPath];
		if (recovering && agent.sessionPath && existsSync(agent.sessionPath)) {
			const recoverySession = join(sessionDir, `recovery-${randomUUID()}.jsonl`);
			copyFileSync(agent.sessionPath, recoverySession);
			args.push("--session", recoverySession);
		} else {
			args.push("--session-dir", sessionDir);
		}
		const invocation = getPiInvocation(args);
		const child = spawn(invocation.command, invocation.args, { cwd: context!.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		agent.process = child;
		agent.pid = child.pid;
		if (!agent.pid) {
			child.kill();
			throw new Error(`Could not obtain PID for ${agent.agentId}`);
		}
		try {
			processJob?.assign(agent.pid);
		} catch (error) {
			await pi.exec("taskkill", ["/PID", String(agent.pid), "/T", "/F"], { timeout: 5000 }).catch(() => undefined);
			throw error;
		}
		agent.intentionalStop = false;
		agent.status = recovering ? "recovering" : "starting";
		agent.rpc = new RpcClient(child, (event) => onRpcEvent(agent, event), (line) => addDetail(agent, `non-JSON stdout: ${truncate(line, 200)}`));
		child.stderr.on("data", (chunk) => addDetail(agent, `stderr: ${truncate(chunk.toString(), 300)}`));
		child.on("error", (error) => addDetail(agent, `process error: ${error.message}`));
		child.on("exit", (code, signal) => {
			agent.rpc?.rejectAll(new Error(`${agent.agentId} exited`));
			agent.rpc = undefined;
			agent.process = undefined;
			agent.pid = undefined;
			addDetail(agent, `process exited code=${code} signal=${signal}`);
			const unexpected = !shuttingDown && !agent.intentionalStop && agent.status !== "cancelled";
			if (unexpected) {
				appendEvent({
					actorId: "supervisor",
					content: `${agentPath(agent.agentId)} crashed and is recovering (code=${code}, signal=${signal})`,
					departmentId: agent.departmentId,
					kind: "error",
					targetIds: agent.parentId ? [agent.parentId] : [],
				});
				void notifyParent(agent, `[${agentPath(agent.agentId)} crashed] Supervisor is recovering the same session. Wait for a settled/idle report before treating the task as complete.`);
				void recoverAgent(agent);
			}
		});
		await waitForReady(agent);
		appendEvent({ actorId: "supervisor", content: `${agentPath(agent.agentId)} [${agent.role}] started: ${agent.task}`, departmentId: agent.departmentId, kind: "status", targetIds: agent.parentId ? [agent.parentId] : [] });
		await deliver(agent, buildInitialPrompt(agent, recovering));
		updateUi();
	}

	async function recoverAgent(agent: RuntimeAgent): Promise<void> {
		if (agent.recoveryAttempts >= RECOVERY_LIMIT) {
			agent.status = "failed";
			appendEvent({ actorId: "supervisor", content: `${agentPath(agent.agentId)} recovery failed after ${RECOVERY_LIMIT} attempts`, departmentId: agent.departmentId, kind: "error", targetIds: agent.parentId ? [agent.parentId] : [] });
			void notifyParent(agent, `[${agentPath(agent.agentId)} recovery failed] The role could not restart after ${RECOVERY_LIMIT} attempts and needs attention.`);
			persistState();
			return;
		}
		agent.recoveryAttempts += 1;
		agent.actorEpoch = randomUUID();
		agent.token = randomBytes(24).toString("hex");
		agent.status = "recovering";
		await new Promise((resolve) => setTimeout(resolve, 500 * agent.recoveryAttempts));
		try {
			await startAgent(agent, true);
			agent.recoveryAttempts = 0;
		} catch (error) {
			addDetail(agent, `recovery attempt failed: ${error instanceof Error ? error.message : String(error)}`);
			void recoverAgent(agent);
		}
	}

	function childCount(parentId: string): number {
		return [...agents.values()].filter((agent) => agent.parentId === parentId && agent.status !== "cancelled").length;
	}

	async function createAgent(role: TeamRole, task: string, parentId?: string, name?: string): Promise<RuntimeAgent> {
		await startupPromise;
		if (role === "boss" && [...agents.values()].filter((a) => a.role === "boss" && a.status !== "cancelled").length >= MAX_BOSSES) throw new Error(`Maximum Boss count is ${MAX_BOSSES}`);
		if (parentId && childCount(parentId) >= MAX_CHILDREN) throw new Error(`${parentId} already has ${MAX_CHILDREN} active children`);
		const parent = parentId ? agents.get(parentId) : undefined;
		if (role === "lead" && parent?.role !== "boss") throw new Error("Only a Boss can own a Department Lead");
		if (role === "worker" && parent?.role !== "lead") throw new Error("Only a Department Lead can own a Worker");
		const index = [...agents.values()].filter((agent) => agent.role === role).length + 1;
		const agentId = `${role}-${index}`;
		const departmentId = role === "lead" ? agentId : role === "worker" ? parent?.departmentId : undefined;
		const agent: RuntimeAgent = {
			actorEpoch: randomUUID(), agentId, configPath: "", departmentId, details: [], intentionalStop: false,
			name: name?.trim() || `${ROLE_NAMES[role]} ${index}`, parentId, pendingParentMessages: [], progressTimer: undefined, recoveryAttempts: 0, role, runCount: 0,
			status: "starting", task: task.trim(), token: randomBytes(24).toString("hex"),
		};
		agents.set(agentId, agent);
		if (role === "boss" && agents.size === 1) pi.setSessionName(teamSessionName());
		persistState();
		try {
			await startAgent(agent);
			return agent;
		} catch (error) {
			agent.status = "failed";
			appendEvent({
				actorId: "supervisor",
				content: `${agent.agentId} failed to start: ${error instanceof Error ? error.message : String(error)}`,
				departmentId: agent.departmentId,
				kind: "error",
				targetIds: parentId ? [parentId] : [],
			});
			persistState();
			throw error;
		}
	}

	function descendants(agentId: string): RuntimeAgent[] {
		const output: RuntimeAgent[] = [];
		for (const child of agents.values()) {
			if (child.parentId !== agentId) continue;
			output.push(...descendants(child.agentId), child);
		}
		return output;
	}

	async function stopProcess(agent: RuntimeAgent): Promise<void> {
		agent.intentionalStop = true;
		agent.status = "cancelled";
		if (agent.progressTimer) clearTimeout(agent.progressTimer);
		agent.progressTimer = undefined;
		try { await agent.rpc?.request({ type: "abort" }, 2000); } catch {}
		if (agent.pid && process.platform === "win32") {
			await pi.exec("taskkill", ["/PID", String(agent.pid), "/T", "/F"], { timeout: 5000 }).catch(() => undefined);
		} else agent.process?.kill("SIGTERM");
		agent.rpc = undefined;
		agent.process = undefined;
		agent.pid = undefined;
	}

	async function cancelAgent(agentId: string, requester?: RuntimeAgent): Promise<string[]> {
		const target = resolveAgent(agentId);
		if (!target) throw new Error(`Unknown agent: ${agentId}`);
		if (requester && target.parentId !== requester.agentId) throw new Error(`${requester.agentId} may only cancel direct subordinates`);
		const list = [...descendants(agentId), target];
		for (const agent of list) await stopProcess(agent);
		appendEvent({ actorId: requester?.agentId || "user", content: `Cancelled ${list.map((a) => agentPath(a.agentId)).join(", ")}`, kind: "control", targetIds: list.map((a) => a.agentId) });
		persistState();
		updateUi();
		return list.map((agent) => agent.agentId);
	}

	function visibleAgents(requester: RuntimeAgent): AgentRecord[] {
		if (requester.role === "boss") return [...agents.values()].filter((agent) => agent.agentId === requester.agentId || agent.parentId === requester.agentId || (agent.parentId && agents.get(agent.parentId)?.parentId === requester.agentId)).map(publicAgent);
		if (requester.role === "lead") return [...agents.values()].filter((agent) => agent.agentId === requester.agentId || agent.parentId === requester.agentId).map(publicAgent);
		return [publicAgent(requester)];
	}

	function canMessage(actor: RuntimeAgent, target: RuntimeAgent): boolean {
		return actor.agentId !== target.agentId;
	}

	function authorized(req: IncomingMessage): RuntimeAgent | undefined {
		const actorId = String(req.headers["x-pi-team-actor"] || "");
		const epoch = String(req.headers["x-pi-team-epoch"] || "");
		const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
		const agent = agents.get(actorId);
		return agent && agent.actorEpoch === epoch && agent.token === token ? agent : undefined;
	}

	async function body(req: IncomingMessage): Promise<any> {
		let text = "";
		for await (const chunk of req) {
			text += chunk.toString();
			if (text.length > 1024 * 1024) throw new Error("Request too large");
		}
		return text ? JSON.parse(text) : {};
	}

	function json(res: ServerResponse, status: number, payload: unknown): void {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(payload));
	}

	async function handleIpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const actor = authorized(req);
		if (!actor) return json(res, 401, { error: "Unauthorized" });
		try {
			const data = await body(req);
			if (req.url === "/delegate") {
				const role: TeamRole = actor.role === "boss" ? "lead" : actor.role === "lead" ? "worker" : (() => { throw new Error("Workers cannot delegate"); })();
				const task = String(data.task || "").trim();
				const reason = String(data.reason || "").trim();
				if (!task) throw new Error("Delegated task is required");
				if (!reason) throw new Error("Delegation reason is required");
				const agent = await createAgent(role, task, actor.agentId, typeof data.name === "string" ? data.name : undefined);
				appendEvent({
					actorId: actor.agentId,
					content: `Delegated ${agentPath(agent.agentId)}: ${reason}`,
					departmentId: agent.departmentId,
					kind: "assignment",
					targetIds: [agent.agentId],
				});
				return json(res, 200, { agent: publicAgent(agent) });
			}
			if (req.url === "/send") {
				const target = resolveAgent(String(data.target || ""), true);
				if (!target) throw new Error("Unknown target");
				if (!canMessage(actor, target)) throw new Error(`${actor.agentId} may only message another role in the same Pi Team`);
				const message = String(data.message || "").trim();
				if (!message) throw new Error("Message is required");
				appendEvent({ actorId: actor.agentId, content: message, departmentId: actor.departmentId, kind: "message", targetIds: [target.agentId] });
				await deliver(target, `[${actor.agentId}] ${message}`);
				return json(res, 200, { delivered: true });
			}
			if (req.url === "/cancel") return json(res, 200, { cancelled: await cancelAgent(String(data.target || ""), actor) });
			if (req.url === "/events") return json(res, 200, { events: roleVisibleEvents(actor, data.drillDown === true).slice(-Math.max(1, Math.min(100, Number(data.limit) || 30))) });
			if (req.url === "/list") return json(res, 200, { agents: visibleAgents(actor) });
			return json(res, 404, { error: "Not found" });
		} catch (error) {
			return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	}

	async function startServer(): Promise<void> {
		server = createServer((req, res) => void handleIpc(req, res));
		await new Promise<void>((resolve, reject) => {
			server!.once("error", reject);
			server!.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Could not start Pi Team IPC server");
		serverUrl = `http://127.0.0.1:${address.port}`;
	}

	pi.registerEntryRenderer<TeamEvent>(TEAM_EVENT_ENTRY, (entry, { expanded }, theme) => {
		const event = entry.data!;
		if (!isMainTranscriptEvent(event)) return undefined;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg(event.kind === "error" ? "error" : "accent", `[${agentPath(event.actorId)}]`)} ${event.content}`, 0, 0));
		if (expanded) box.addChild(new Text(theme.fg("dim", `#${event.seq} -> ${event.targetIds.map(agentPath).join(", ") || "group"} · ${event.timestamp}`), 0, 0));
		return box;
	});

	pi.registerCommand("team", { description: "Show Pi Team status", handler: async (_args, ctx) => {
		const sessionFile = context?.sessionManager.getSessionFile() ?? teamSessionMirror?.getSessionFile();
		ctx.ui.notify(`${agents.size} agents; focused Boss: ${focusedBossId || "none"}; session: ${sessionFile || "not created"}; IPC: ${serverUrl || "starting"}`, "info");
	}});
	pi.registerCommand("boss", { description: "Create and focus a new Boss", handler: async (args, ctx) => {
		const task = args.trim();
		if (!task) return ctx.ui.notify("Usage: /boss <task>", "warning");
		try {
			const agent = await createAgent("boss", task);
			focusedBossId = agent.agentId;
			persistState(); updateUi();
			ctx.ui.notify(`Created and focused ${agent.agentId}`, "info");
		} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
	}});
	pi.registerCommand("to", { description: "Send a directed message to a team agent", handler: async (args, ctx) => {
		const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
		if (!match) return ctx.ui.notify("Usage: /to <agent-id> <message>", "warning");
		const agent = resolveAgent(match[1]);
		if (!agent) return ctx.ui.notify(`Unknown agent: ${match[1]}`, "error");
		appendEvent({ actorId: "user", content: match[2], departmentId: agent.departmentId, kind: "message", targetIds: [agent.agentId] });
		try { await deliver(agent, `[User] ${match[2]}`); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
	}});
	pi.registerCommand("focus", { description: "Route ordinary input to a Boss", handler: async (args, ctx) => {
		const agent = resolveAgent(args.trim());
		if (!agent || agent.role !== "boss") return ctx.ui.notify("Usage: /focus <boss-id>", "warning");
		focusedBossId = agent.agentId; persistState(); updateUi(); ctx.ui.notify(`Focused ${agent.agentId}`, "info");
	}});
	pi.registerCommand("cancel", { description: "Cancel an agent and its descendants", handler: async (args, ctx) => {
		try { await cancelAgent(args.trim()); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
	}});
	pi.registerCommand("agents", { description: "List Pi Team agents", handler: async (_args, ctx) => {
		ctx.ui.notify([...agents.values()].map((agent) => `${agentPath(agent.agentId)} [${agent.role}/${agent.status} r${agent.runCount ?? 0}] ${agent.task}`).join("\n") || "No agents.", "info");
	}});
	pi.registerCommand("view", { description: "View recent formal group-chat events", handler: async (args, ctx) => {
		const requested = Number.parseInt(args.trim(), 10);
		const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, requested)) : 30;
		const lines = events.slice(-limit).map((event) => `#${event.seq} ${agentPath(event.actorId)} -> ${event.targetIds.map(agentPath).join(",") || "group"}: ${event.content}`);
		ctx.ui.notify(lines.join("\n") || "No team events.", "info");
	}});
	pi.registerCommand("inspect", { description: "Show one agent's RPC activity in the bottom team panel", handler: async (args, ctx) => {
		const target = args.trim();
		if (target === "off") {
			inspectedAgentId = undefined;
			updateUi();
			return;
		}
		const agent = resolveAgent(target);
		if (!agent) return ctx.ui.notify("Usage: /inspect <agent-id|off>", "warning");
		inspectedAgentId = agent.agentId;
		updateUi();
		ctx.ui.notify([`${agentPath(agent.agentId)} [${agent.role}/${agent.status} r${agent.runCount ?? 0}]`, `Task: ${agent.task}`, ...agent.details.slice(-10)].join("\n"), "info");
	}});

	pi.on("input", async (event) => {
		if (event.source === "extension" || !focusedBossId) return;
		const agent = agents.get(focusedBossId);
		if (!agent) return;
		appendEvent({ actorId: "user", content: event.text, kind: "message", targetIds: [agent.agentId] });
		try { await deliver(agent, `[User] ${event.text}`); } catch (error) { context?.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		return { action: "handled" as const };
	});

	startupPromise = (async () => {
		processJob = await createProcessJob();
		await startServer();
	})();

	pi.on("session_start", async (event, ctx) => {
		shuttingDown = false;
		await startupPromise;
		reconstruct(ctx, event.reason);
		for (const agent of agents.values()) {
			if (agent.status === "cancelled") continue;
			void startAgent(agent, true).catch((error) => addDetail(agent, `resume failed: ${error instanceof Error ? error.message : String(error)}`));
		}
		updateUi();
	});

	pi.on("session_tree", async (_event, ctx) => {
		shuttingDown = true;
		await startupPromise;
		for (const agent of agents.values()) await stopProcess(agent);
		reconstruct(ctx, "tree");
		shuttingDown = false;
		for (const agent of agents.values()) {
			if (agent.status === "cancelled") continue;
			void startAgent(agent, true).catch((error) => addDetail(agent, `tree resume failed: ${error instanceof Error ? error.message : String(error)}`));
		}
		updateUi();
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		await startupPromise?.catch(() => undefined);
		for (const batch of parentNotifications.values()) if (batch.timer) clearTimeout(batch.timer);
		parentNotifications.clear();
		context?.ui.setWidget(TEAM_WIDGET_KEY, undefined);
		activityPanel = undefined;
		server?.close();
		for (const agent of agents.values()) await stopProcess(agent);
		processJob?.close();
		processJob = undefined;
		startupPromise = undefined;
	});
}

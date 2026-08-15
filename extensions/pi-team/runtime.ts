import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RpcPromptRequester {
	request(command: { message: string; streamingBehavior: "steer"; type: "prompt" }): Promise<unknown>;
}

export type ModelPool = Record<string, string>;

type TreeAgent = {
	agentId: string;
	identity?: string;
	model?: string;
	parentId?: string;
	role: "boss" | "lead" | "worker";
	runCount?: number;
	status: string;
};

export function formatAgentTree(allAgents: TreeAgent[], focusedBossId?: string): string[] {
	const children = (parentId: string, role: TreeAgent["role"]): TreeAgent[] => allAgents.filter((agent) => agent.parentId === parentId && agent.role === role);
	const label = (agent: TreeAgent): string => `${agent.agentId} [${agent.identity ?? "inherited"}: ${agent.model ?? "default"}] [${agent.status} r${agent.runCount ?? 0}]`;
	const lines: string[] = [];
	for (const boss of allAgents.filter((agent) => agent.role === "boss")) {
		lines.push(`${boss.agentId === focusedBossId ? ">" : " "} ${label(boss)}`);
		const leads = children(boss.agentId, "lead");
		leads.forEach((lead, leadIndex) => {
			const lastLead = leadIndex === leads.length - 1;
			const workers = children(lead.agentId, "worker");
			lines.push(`  ${lastLead ? "└─" : "├─"} ${label(lead)} (${workers.length} worker${workers.length === 1 ? "" : "s"})`);
			workers.forEach((worker, workerIndex) => {
				lines.push(`  ${lastLead ? "   " : "│  "}${workerIndex === workers.length - 1 ? "└─" : "├─"} ${label(worker)}`);
			});
		});
	}
	return lines;
}

export const BUILTIN_IDENTITIES = ["text-high", "text-medium", "text-low", "vision-high", "vision-medium", "vision-low"] as const;

export function readModelPool(poolPath: string): ModelPool {
	return readJsonFile<ModelPool>(poolPath) ?? {};
}

export function resolveModelPattern(pool: ModelPool, identity?: string): string | undefined {
	if (!identity) return pool.default;
	const pattern = pool[identity];
	if (!pattern) throw new Error(`Unknown identity: "${identity}". Add it to .pi/pi-team/identities.json; configured: ${Object.keys(pool).join(", ") || "none"}`);
	return pattern;
}

export function resolveSpawnModel(pool: ModelPool, identity: string | undefined, mainModel: { provider: string; id: string } | undefined): string | undefined {
	if (identity) return resolveModelPattern(pool, identity);
	return mainModel ? `${mainModel.provider}/${mainModel.id}` : undefined;
}

export function formatProgress(progress: unknown): string {
	const items = Array.isArray(progress) ? progress : [progress];
	return items.filter((item): item is string => typeof item === "string").join("\n\n");
}

export function readJsonFile<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function readJsonLines<T>(path: string): T[] {
	try {
		return readFileSync(path, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.flatMap((line) => {
				try { return [JSON.parse(line) as T]; }
				catch { return []; }
			});
	} catch {
		return [];
	}
}

export function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
	renameSync(temporaryPath, path);
}

export async function sendRpcPrompt(rpc: RpcPromptRequester, message: string): Promise<void> {
	await rpc.request({ type: "prompt", message, streamingBehavior: "steer" });
}

import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const cwd = resolve(import.meta.dirname, "../..");
const extension = resolve(import.meta.dirname, "index.ts");
const command = process.platform === "win32" ? "pi.cmd" : "pi";
const child = spawn(command, ["--mode", "rpc", "--no-session", "--no-extensions", "-e", extension], {
	cwd,
	shell: process.platform === "win32",
	stdio: ["pipe", "pipe", "pipe"],
	windowsHide: true,
});
const decoder = new StringDecoder("utf8");
let buffer = "";
let stderr = "";
let nextId = 1;
const events = [];
const pending = new Map();

function send(type, fields = {}) {
	const id = `smoke-${nextId++}`;
	child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`${type} timed out`));
		}, 60_000);
		pending.set(id, { resolve: resolvePromise, reject, timer });
	});
}

function onLine(line) {
	if (!line.trim()) return;
	let event;
	try { event = JSON.parse(line); }
	catch { events.push({ type: "non-json", line }); return; }
	events.push(event);
	if (event.type !== "response" || !event.id || !pending.has(event.id)) return;
	const item = pending.get(event.id);
	clearTimeout(item.timer);
	pending.delete(event.id);
	event.success ? item.resolve(event) : item.reject(new Error(event.error || `${event.command} failed`));
}

child.stdout.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	while (true) {
		const newline = buffer.indexOf("\n");
		if (newline === -1) break;
		let line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		onLine(line);
	}
});
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

async function postAs(config, path, body) {
	const response = await fetch(`${config.serverUrl}${path}`, {
		method: "POST",
		headers: {
			"authorization": `Bearer ${config.token}`,
			"content-type": "application/json",
			"x-pi-team-actor": config.agentId,
			"x-pi-team-epoch": config.actorEpoch,
		},
		body: JSON.stringify(body),
	});
	const payload = await response.json();
	if (!response.ok) throw new Error(payload.error || `${path} failed`);
	return payload;
}

async function expectRejected(action, fragment) {
	try {
		await action();
	} catch (error) {
		if (String(error).includes(fragment)) return;
		throw error;
	}
	throw new Error(`Expected rejection containing: ${fragment}`);
}

async function waitForEntry(predicate, timeoutMs = 180_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const response = await send("get_entries");
		const entries = response.data?.entries ?? [];
		const startupError = [...entries].reverse().find((entry) =>
			entry.customType === "pi-team-event" &&
			entry.data?.kind === "error" &&
			/(failed to start|recovery failed)/.test(entry.data?.content || ""),
		);
		if (startupError) throw new Error(startupError.data.content);
		if (predicate(entries)) return entries;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
	}
	throw new Error(`Expected session entry timed out. Recent events: ${JSON.stringify(events.slice(-20))}`);
}

try {
	await send("get_state");
	await send("prompt", { message: "/boss Reply with exactly BOSS_SMOKE_ONE and no other text." });
	const firstEntries = await waitForEntry((entries) => entries.some((entry) => entry.customType === "pi-team-event" && entry.data?.actorId === "boss-1" && entry.data?.content.includes("BOSS_SMOKE_ONE")));
	const firstBossState = [...firstEntries].reverse().find((entry) => entry.customType === "pi-team-state" && entry.data?.agents?.some((agent) => agent.agentId === "boss-1" && agent.pid));
	const firstBossPid = firstBossState?.data?.agents?.find((agent) => agent.agentId === "boss-1")?.pid;
	if (!firstBossPid) throw new Error("Initial Boss PID was not persisted");
	if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(firstBossPid), "/F"], { stdio: "ignore" });
	else process.kill(firstBossPid, "SIGKILL");
	await waitForEntry((entries) => entries.some((entry) => entry.customType === "pi-team-state" && entry.data?.agents?.some((agent) => agent.agentId === "boss-1" && agent.pid && agent.pid !== firstBossPid && agent.status === "idle")));
	await send("prompt", { message: "/to boss-1 Reply with exactly BOSS_SMOKE_TWO and no other text." });
	const entries = await waitForEntry((items) => items.some((entry) => entry.customType === "pi-team-event" && entry.data?.actorId === "boss-1" && entry.data?.content.includes("BOSS_SMOKE_TWO")));
	const bossState = [...entries].reverse().find((entry) => entry.customType === "pi-team-state" && entry.data?.agents?.some((agent) => agent.agentId === "boss-1"));
	const bossRecord = bossState.data.agents.find((agent) => agent.agentId === "boss-1");
	const teamAgentDir = resolve(dirname(bossRecord.sessionPath), "../..");
	const bossConfig = JSON.parse(readFileSync(resolve(teamAgentDir, "boss-1/instance.json"), "utf8"));
	const lead = (await postAs(bossConfig, "/delegate", { task: "Capacity smoke lead; wait for direction.", reason: "Exercise the explicit maximum-capacity control path.", name: "Capacity Lead" })).agent;
	const leadConfig = JSON.parse(readFileSync(resolve(teamAgentDir, `${lead.agentId}/instance.json`), "utf8"));
	const workers = await Promise.all(Array.from({ length: 4 }, (_, index) => postAs(leadConfig, "/delegate", { task: `Capacity smoke worker ${index + 1}; wait for direction.`, reason: `Verify concurrent Worker slot ${index + 1} remains available for complex tasks.` })));
	if (new Set(workers.map((result) => result.agent.agentId)).size !== 4) throw new Error("Worker IDs were not unique");
	const workerConfigs = workers.map((result) => JSON.parse(readFileSync(resolve(teamAgentDir, `${result.agent.agentId}/instance.json`), "utf8")));
	const crossLead = (await postAs(bossConfig, "/delegate", { task: "Cross-branch messaging smoke lead; wait for direction.", reason: "Create a second department to verify same-Team cross-branch messaging.", name: "Capacity Lead" })).agent;
	const crossLeadConfig = JSON.parse(readFileSync(resolve(teamAgentDir, `${crossLead.agentId}/instance.json`), "utf8"));
	const crossWorker = (await postAs(crossLeadConfig, "/delegate", { task: "Cross-branch messaging smoke worker; wait for direction.", reason: "Provide a Worker under a different Lead for messaging verification.", name: "Cross Branch Worker" })).agent;
	const crossWorkerConfig = JSON.parse(readFileSync(resolve(teamAgentDir, `${crossWorker.agentId}/instance.json`), "utf8"));

	const messages = {
		parentChild: "TEAM_MSG_PARENT_CHILD",
		siblingWorker: "TEAM_MSG_SIBLING_WORKER",
		crossWorker: "TEAM_MSG_CROSS_WORKER",
		siblingLead: "TEAM_MSG_SIBLING_LEAD",
		nonDirectLeadWorker: "TEAM_MSG_NONDIRECT_LEAD_WORKER",
		reverseLeadWorker: "TEAM_MSG_REVERSE_LEAD_WORKER",
	};
	await postAs(leadConfig, "/send", { target: `@${workers[0].agent.agentId}`, message: messages.parentChild });
	await postAs(workerConfigs[0], "/send", { target: `@${workers[1].agent.path}`, message: messages.siblingWorker });
	await postAs(workerConfigs[0], "/send", { target: "@Cross Branch Worker", message: messages.crossWorker });
	await postAs(leadConfig, "/send", { target: crossLead.path, message: messages.siblingLead });
	await postAs(leadConfig, "/send", { target: crossWorker.agentId, message: messages.nonDirectLeadWorker });
	await postAs(crossWorkerConfig, "/send", { target: lead.agentId, message: messages.reverseLeadWorker });
	await expectRejected(() => postAs(workerConfigs[0], "/send", { target: workers[0].agent.agentId, message: "self must fail" }), "may only message another role in the same Pi Team");
	await expectRejected(() => postAs(workerConfigs[0], "/send", { target: "@missing-worker", message: "unknown must fail" }), "Unknown target");
	await expectRejected(() => postAs(workerConfigs[0], "/send", { target: "@Capacity Lead", message: "ambiguous must fail" }), "Ambiguous target name");
	await expectRejected(() => postAs({ ...workerConfigs[0], actorEpoch: "foreign-team-epoch", token: "foreign-team-token" }, "/send", { target: crossWorker.agentId, message: "cross-team must fail" }), "Unauthorized");
	await expectRejected(() => postAs(workerConfigs[0], "/delegate", { task: "must fail", reason: "Workers still cannot delegate team roles." }), "Workers cannot delegate");
	await expectRejected(() => postAs(leadConfig, "/cancel", { target: crossWorker.agentId }), "may only cancel direct subordinates");

	const messagingEntries = await waitForEntry((items) => Object.values(messages).every((message) => items.some((entry) => entry.customType === "pi-team-event" && entry.data?.kind === "message" && entry.data?.content === message)));
	const crossMessage = messagingEntries.find((entry) => entry.customType === "pi-team-event" && entry.data?.content === messages.crossWorker);
	if (crossMessage?.data?.actorId !== workers[0].agent.agentId || crossMessage.data.targetIds?.[0] !== crossWorker.agentId) throw new Error("Cross-worker group-chat event lost authenticated actor or target identity");

	let fifthRejected = false;
	try { await postAs(leadConfig, "/delegate", { task: "This fifth worker must be rejected.", reason: "Verify the hard safety ceiling still rejects a fifth concurrent Worker." }); }
	catch (error) { fifthRejected = String(error).includes("already has 4 active children"); }
	if (!fifthRejected) throw new Error("Fifth Worker was not rejected by the capacity limit");
	const listed = await postAs(leadConfig, "/list", {});
	if (listed.agents.filter((agent) => agent.role === "worker").length !== 4) throw new Error("Lead could not list four Workers");
	await postAs(bossConfig, "/cancel", { target: lead.agentId });
	await send("prompt", { message: "/cancel boss-1" });
	const finalEntries = await waitForEntry((items) => items.some((entry) => entry.customType === "pi-team-event" && entry.data?.kind === "control" && entry.data?.actorId === "user" && entry.data?.content.includes("boss-1")));
	if (!entries.some((entry) => entry.customType === "pi-team-state" && entry.data?.focusedBossId === "boss-1")) throw new Error("Focused Boss was not persisted");
	if (events.some((event) => event.type === "non-json")) throw new Error("RPC stdout contained non-JSON output");
	if (stderr.trim()) throw new Error(`Supervisor stderr was not empty: ${stderr.trim()}`);
	console.log(`PASS boss replies=2 recoveryPid=${firstBossPid}->new hierarchy=1+2+5 capacityLimit=ok messaging=parent+sibling+cross-branch visibility=ok isolation=ok entries=${finalEntries.length} rpcEvents=${events.length}`);
} finally {
	for (const item of pending.values()) {
		clearTimeout(item.timer);
		item.reject(new Error("Smoke test shutting down"));
	}
	pending.clear();
	child.kill();
	setTimeout(() => child.kill("SIGKILL"), 2000).unref();
}

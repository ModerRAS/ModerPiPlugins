import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_IDENTITIES, formatAgentTree, formatProgress, readJsonFile, readJsonLines, readModelPool, resolveModelPattern, resolveSpawnModel, sendRpcPrompt, writeJsonAtomic } from "./runtime.ts";

test("formatProgress accepts preformatted and array progress", () => {
	const progress = ["first update", "second update"];
	const preformatted = progress.join("\n\n");

	assert.equal(formatProgress(progress), preformatted);
	assert.equal(formatProgress(preformatted), preformatted);
});

test("team tree shows hierarchy, Worker counts, and model selections", () => {
	const agents = [
		{ agentId: "boss-1", model: "opencode-go/gpt-5.6-luna", role: "boss", status: "idle", runCount: 2 },
		{ agentId: "lead-1", identity: "text-high", model: "opencode-go/deepseek-v4-pro", parentId: "boss-1", role: "lead", status: "running", runCount: 1 },
		{ agentId: "worker-1", identity: "text-medium", model: "opencode-go/deepseek-v4-flash", parentId: "lead-1", role: "worker", status: "idle", runCount: 1 },
		{ agentId: "worker-2", identity: "vision-low", model: "opencode-go/mimo-v2.5", parentId: "lead-1", role: "worker", status: "running", runCount: 3 },
		{ agentId: "lead-2", identity: "vision-high", model: "opencode-go/gpt-5.6-luna", parentId: "boss-1", role: "lead", status: "idle", runCount: 0 },
	];

	assert.deepEqual(formatAgentTree(agents, "boss-1"), [
		"> boss-1 [inherited: opencode-go/gpt-5.6-luna] [idle r2]",
		"  ├─ lead-1 [text-high: opencode-go/deepseek-v4-pro] [running r1] (2 workers)",
		"  │  ├─ worker-1 [text-medium: opencode-go/deepseek-v4-flash] [idle r1]",
		"  │  └─ worker-2 [vision-low: opencode-go/mimo-v2.5] [running r3]",
		"  └─ lead-2 [vision-high: opencode-go/gpt-5.6-luna] [idle r0] (0 workers)",
	]);
	assert.equal(formatAgentTree(agents.filter((agent) => agent.agentId !== "worker-1"), "boss-1")[1], "  ├─ lead-1 [text-high: opencode-go/deepseek-v4-pro] [running r1] (1 worker)");
});

test("durable team state and events survive restart reads", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-team-"));
	try {
		const statePath = join(root, "team", "state.json");
		const eventsPath = join(root, "team", "events.jsonl");
		writeJsonAtomic(statePath, { focusedBossId: "boss-1", agents: [{ agentId: "boss-1" }] });
		writeJsonAtomic(statePath, { focusedBossId: "boss-2", agents: [{ agentId: "boss-2" }] });
		await mkdir(join(root, "team"), { recursive: true });
		await writeFile(eventsPath, '{"seq":1,"content":"first"}\n{"incomplete":', "utf8");

		assert.deepEqual(readJsonFile(statePath), { focusedBossId: "boss-2", agents: [{ agentId: "boss-2" }] });
		assert.deepEqual(readJsonLines(eventsPath), [{ seq: 1, content: "first" }]);
		assert.deepEqual((await readdir(join(root, "team"))).filter((name) => name.endsWith(".tmp")), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("identity pool resolves models and rejects unknown ones", () => {
	const pool = { default: "opencode-go/deepseek-v4-flash", planner: "opencode-go/deepseek-v4-flash", gui: "opencode-go/gpt-5.6-luna" };

	assert.equal(resolveModelPattern(pool), "opencode-go/deepseek-v4-flash");
	assert.equal(resolveModelPattern(pool, "planner"), "opencode-go/deepseek-v4-flash");
	assert.equal(resolveModelPattern(pool, "gui"), "opencode-go/gpt-5.6-luna");
	assert.throws(() => resolveModelPattern(pool, "nope"), /Unknown identity/);
	assert.equal(resolveModelPattern({}), undefined);
});

test("identities.json overrides models.json", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-team-identities-"));
	try {
		writeJsonAtomic(join(root, "models.json"), { git: "a/b", gui: "a/c" });
		writeJsonAtomic(join(root, "identities.json"), { gui: "x/y" });

		const pool = { ...readModelPool(join(root, "models.json")), ...readModelPool(join(root, "identities.json")) };
		assert.equal(pool.git, "a/b");
		assert.equal(pool.gui, "x/y");
		assert.equal(pool.nope, undefined);
		assert.ok(BUILTIN_IDENTITIES.includes("vision-high"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("spawn model falls back to main conversation model when no identity", () => {
	const pool = { "text-low": "opencode-go/mimo-v2.5-pro" };
	const main = { provider: "opencode-go", id: "deepseek-v4-flash" };

	assert.equal(resolveSpawnModel(pool, undefined, main), "opencode-go/deepseek-v4-flash");
	assert.equal(resolveSpawnModel(pool, "text-low", main), "opencode-go/mimo-v2.5-pro");
	assert.equal(resolveSpawnModel(pool, undefined, undefined), undefined);
	assert.throws(() => resolveSpawnModel(pool, "nope", main), /Unknown identity/);
});

test("model pool loads from user file", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-team-models-"));
	try {
		const poolPath = join(root, "models.json");
		writeJsonAtomic(poolPath, { gui: "openai/gpt-5.6-sol:high", cli: "anthropic/claude-haiku-4-5" });

		assert.deepEqual(readModelPool(poolPath), { gui: "openai/gpt-5.6-sol:high", cli: "anthropic/claude-haiku-4-5" });
		assert.deepEqual(readModelPool(join(root, "missing.json")), {});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("sendRpcPrompt queues busy agents with explicit steer behavior", async () => {
	let received;
	const busyRpc = {
		async request(command) {
			if (command.type === "prompt" && !command.streamingBehavior) {
				throw new Error("streamingBehavior is required while busy");
			}
			received = command;
		},
	};

	await assert.doesNotReject(() => sendRpcPrompt(busyRpc, "new team event"));
	assert.deepEqual(received, {
		type: "prompt",
		message: "new team event",
		streamingBehavior: "steer",
	});
});

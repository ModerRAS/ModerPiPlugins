import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { formatProgress, readJsonFile, readJsonLines, sendRpcPrompt, writeJsonAtomic } from "./runtime.ts";

test("formatProgress accepts preformatted and array progress", () => {
	const progress = ["first update", "second update"];
	const preformatted = progress.join("\n\n");

	assert.equal(formatProgress(progress), preformatted);
	assert.equal(formatProgress(preformatted), preformatted);
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

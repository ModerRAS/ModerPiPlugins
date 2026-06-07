import {
	createAssistantMessageEventStream,
	getApiProvider,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type StreamDelegate = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

interface RetryConfig {
	apis?: Set<string>;
	providers?: Set<string>;
	baseDelayMs: number;
	maxDelayMs: number;
	maxAttempts?: number;
	debug: boolean;
}

function parseList(value: string | undefined): Set<string> | undefined {
	if (!value) return undefined;
	const entries = value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return entries.length > 0 ? new Set(entries) : undefined;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readConfig(): RetryConfig {
	return {
		apis: parseList(process.env.PI_INFINITE_RETRY_APIS),
		providers: parseList(process.env.PI_INFINITE_RETRY_PROVIDERS),
		baseDelayMs: parsePositiveInteger(process.env.PI_INFINITE_RETRY_BASE_DELAY_MS, 2000),
		maxDelayMs: parsePositiveInteger(process.env.PI_INFINITE_RETRY_MAX_DELAY_MS, 30000),
		maxAttempts: parseOptionalPositiveInteger(process.env.PI_INFINITE_RETRY_MAX_ATTEMPTS),
		debug: process.env.PI_INFINITE_RETRY_DEBUG === "1",
	};
}

function cloneEvent<T>(value: T): T {
	if (typeof structuredClone === "function") {
		return structuredClone(value);
	}
	return JSON.parse(JSON.stringify(value)) as T;
}

function createTerminalMessage(
	model: Model<Api>,
	reason: "error" | "aborted",
	errorMessage: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: reason,
		errorMessage,
		timestamp: Date.now(),
	};
}

function createTerminalEvent(message: AssistantMessage): AssistantMessageEvent {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		return {
			type: "error",
			reason: message.stopReason,
			error: cloneEvent(message),
		};
	}
	return {
		type: "done",
		reason: message.stopReason === "toolUse" ? "toolUse" : message.stopReason === "length" ? "length" : "stop",
		message: cloneEvent(message),
	};
}

function shouldWrapModel(config: RetryConfig, model: Model<Api>): boolean {
	if (config.apis && !config.apis.has(model.api)) return false;
	if (config.providers && !config.providers.has(model.provider)) return false;
	return true;
}

function isRetryableFailure(message: AssistantMessage): boolean {
	return message.stopReason === "error";
}

function getDelayMs(config: RetryConfig, attempt: number): number {
	const rawDelay = config.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	return Math.min(rawDelay, config.maxDelayMs);
}

async function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (delayMs <= 0) return;
	if (signal?.aborted) {
		throw new Error("Retry aborted");
	}
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			reject(new Error("Retry aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function createWrappedStream(api: Api, delegate: StreamDelegate, config: RetryConfig): StreamDelegate {
	return (model, context, options) => {
		if (model.api !== api || !shouldWrapModel(config, model)) {
			return delegate(model, context, options);
		}

		const outerStream = createAssistantMessageEventStream();

		void (async () => {
			let attempt = 0;

			while (true) {
				attempt += 1;
				const innerStream = delegate(model, context, options);
				const attemptEvents: AssistantMessageEvent[] = [];
				let terminalEvent: AssistantMessageEvent | undefined;

				try {
					for await (const event of innerStream) {
						const clonedEvent = cloneEvent(event);
						attemptEvents.push(clonedEvent);
						if (clonedEvent.type === "done" || clonedEvent.type === "error") {
							terminalEvent = clonedEvent;
							break;
						}
					}
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					terminalEvent = createTerminalEvent(
						createTerminalMessage(model, options?.signal?.aborted ? "aborted" : "error", errorMessage),
					);
					attemptEvents.push(terminalEvent);
				}

				if (!terminalEvent) {
					terminalEvent = createTerminalEvent(
						createTerminalMessage(
							model,
							options?.signal?.aborted ? "aborted" : "error",
							"Provider stream ended without a terminal event",
						),
					);
					attemptEvents.push(terminalEvent);
				}

				const terminalMessage = terminalEvent.type === "done" ? terminalEvent.message : terminalEvent.error;
				const shouldRetry =
					terminalEvent.type === "error" &&
					isRetryableFailure(terminalMessage) &&
					(config.maxAttempts === undefined || attempt < config.maxAttempts);

				if (shouldRetry) {
					if (config.debug) {
						console.warn(
							`[infinite-retry] retry ${attempt} for ${model.provider}/${model.id}: ${terminalMessage.errorMessage ?? "unknown error"}`,
						);
					}
					await sleepWithAbort(getDelayMs(config, attempt), options?.signal);
					continue;
				}

				for (const bufferedEvent of attemptEvents) {
					outerStream.push(bufferedEvent);
				}
				return;
			}
		})().catch((error) => {
			const errorMessage = error instanceof Error ? error.message : String(error);
			outerStream.push(
				createTerminalEvent(
					createTerminalMessage(model, options?.signal?.aborted ? "aborted" : "error", errorMessage),
				),
			);
		});

		return outerStream;
	};
}

function toStatusText(config: RetryConfig): string {
	const attemptText = config.maxAttempts === undefined ? "∞" : String(config.maxAttempts);
	return `api retry:${attemptText}`;
}

export default function infiniteRetryExtension(pi: ExtensionAPI) {
	const config = readConfig();
	const wrappedStreams = new Map<Api, StreamDelegate>();

	const ensureWrappedApi = (api: Api | undefined) => {
		if (!api) return;
		if (config.apis && !config.apis.has(api)) return;

		const currentProvider = getApiProvider(api);
		if (!currentProvider) return;

		const activeWrapper = wrappedStreams.get(api);
		if (activeWrapper && currentProvider.streamSimple === activeWrapper) {
			return;
		}

		const wrappedStream = createWrappedStream(api, currentProvider.streamSimple, config);
		wrappedStreams.set(api, wrappedStream);
		pi.registerProvider(`infinite-retry-${api}`, {
			api,
			streamSimple: wrappedStream,
		});
	};

	const ensureWrappedKnownApis = (models: Model<Api>[]) => {
		for (const model of models) {
			if (!shouldWrapModel(config, model)) continue;
			ensureWrappedApi(model.api);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		ensureWrappedKnownApis(ctx.modelRegistry.getAll());
		if (ctx.hasUI) {
			ctx.ui.setStatus("infinite-retry", toStatusText(config));
		}
	});

	pi.on("model_select", async (event) => {
		ensureWrappedApi(event.model.api);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		ensureWrappedApi(ctx.model?.api);
	});
}

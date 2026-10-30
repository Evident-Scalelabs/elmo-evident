import { createHash } from "node:crypto";
import { createGateway } from "ai";
import { z } from "zod";
import { getCredential } from "../../secrets";
import { extractRun } from "../../text-extraction";
import { API_PROVIDER_MAX_OUTPUT_TOKENS, configuredWhen, reportedWebQueries, warnIfOutputCapped } from "../config";
import type {
	Provider,
	ProviderOptions,
	ScrapeResult,
	StructuredResearchOptions,
	StructuredResearchResult,
} from "../types";
import { jsonSchemaResponseFormat, parseSchemaJson } from "./ai-sdk";

const CHAT_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const RESPONSES_URL = "https://ai-gateway.vercel.sh/v1/responses";
const MESSAGES_URL = "https://ai-gateway.vercel.sh/v1/messages";
const SDK_URL = "https://ai-gateway.vercel.sh/v4/ai/language-model";
const DEFAULT_RESEARCH_MODEL = "anthropic/claude-sonnet-5.5";

function gatewayHeaders(url: string): Record<string, string> {
	const key = getCredential("AI_GATEWAY_API_KEY");
	if (!key?.trim()) throw new Error("AI_GATEWAY_API_KEY is required before Gateway dispatch");
	return {
		Authorization: `Bearer ${key}`,
		"Content-Type": "application/json",
		...(url === MESSAGES_URL ? { "anthropic-version": "2023-06-01" } : {}),
	};
}

let availableModels: { expiresAt: number; ids: Set<string> } | undefined;
export async function assertAiGatewayModelAvailable(model: string): Promise<void> {
	if (!availableModels || availableModels.expiresAt <= Date.now()) {
		const response = await fetch("https://ai-gateway.vercel.sh/v1/models", {
			redirect: "error",
			signal: AbortSignal.timeout(15000),
		});
		if (!response.ok) throw new Error("Gateway model catalog is unavailable; no inference was dispatched");
		const catalog = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await response.json());
		availableModels = { expiresAt: Date.now() + 300000, ids: new Set(catalog.data.map((entry) => entry.id)) };
	}
	if (!availableModels.ids.has(model))
		throw new Error(`Exact Gateway model ${model} is unavailable; no substitute or inference was dispatched`);
}

export function aiGatewayAcquisitionEndpoint(target: { model: string; grounding: "none" | "native" }): string {
	if (target.grounding === "none") return CHAT_URL;
	if (target.model.startsWith("openai/")) return RESPONSES_URL;
	if (target.model.startsWith("anthropic/")) return MESSAGES_URL;
	if (target.model.startsWith("perplexity/")) return CHAT_URL;
	if (["google/", "x-ai/", "spacexai/"].some((prefix) => target.model.startsWith(prefix))) return SDK_URL;
	throw new Error(
		`Native search protocol is unavailable for ${target.model}; select a supported native protocol or an ungrounded target`,
	);
}

function requestBody(model: string, prompt: string, maxTokens: number, grounding: "none" | "native") {
	const url = aiGatewayAcquisitionEndpoint({ model, grounding });
	if (url === RESPONSES_URL)
		return {
			url,
			body: {
				model,
				input: prompt,
				max_output_tokens: maxTokens,
				tools: [{ type: "web_search", search_context_size: "low" }],
				tool_choice: "required",
			},
		};
	if (url === MESSAGES_URL)
		return {
			url,
			body: {
				model,
				messages: [{ role: "user", content: prompt }],
				max_tokens: maxTokens,
				tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
			},
		};
	return { url, body: { model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens } };
}

export const aiGateway: Provider = {
	id: "ai-gateway",
	name: "Vercel AI Gateway",
	access: "api",
	docsAnchor: "direct-model-apis",
	isConfigured: configuredWhen("AI_GATEWAY_API_KEY"),
	validateTarget(config) {
		if (!config.version) return "AI Gateway requires an explicit model version in SCRAPE_TARGETS";
		try {
			aiGatewayAcquisitionEndpoint({ model: config.version, grounding: config.webSearch ? "native" : "none" });
			return null;
		} catch (error) {
			return String(error);
		}
	},
	async runStructuredResearch<T>({
		prompt,
		schema,
		webSearch = true,
	}: StructuredResearchOptions<T>): Promise<StructuredResearchResult<T>> {
		await assertAiGatewayModelAvailable(DEFAULT_RESEARCH_MODEL);
		const request = requestBody(
			DEFAULT_RESEARCH_MODEL,
			prompt,
			API_PROVIDER_MAX_OUTPUT_TOKENS["ai-gateway"],
			webSearch ? "native" : "none",
		);
		const format = jsonSchemaResponseFormat(schema);
		const body =
			request.url === MESSAGES_URL
				? { ...request.body, output_config: { format: { type: "json_schema", schema: z.toJSONSchema(schema) } } }
				: { ...request.body, response_format: format };
		const res = await fetch(request.url, {
			method: "POST",
			redirect: "error",
			headers: gatewayHeaders(request.url),
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`AI Gateway API error (${res.status}): ${await res.text()}`);
		const data = await res.json();
		const finish = data.stop_reason ?? data.choices?.[0]?.finish_reason;
		if (finish !== "end_turn" && finish !== "stop") throw new Error("AI Gateway research did not finish normally");
		const extracted = extractRun(data, "ai-gateway");
		return {
			object: parseSchemaJson(schema, extracted.textContent ?? ""),
			modelVersion: data.model ?? DEFAULT_RESEARCH_MODEL,
		};
	},
	async run(_model: string, prompt: string, options?: ProviderOptions): Promise<ScrapeResult> {
		if (!options?.version) throw new Error("AI Gateway requires an explicit model version in SCRAPE_TARGETS");
		await assertAiGatewayModelAvailable(options.version);
		const envelope = await acquireAiGatewayAnswer(
			{
				provider: "ai-gateway",
				model: options.version,
				access: "api",
				surface: "direct_model_api",
				grounding: options.webSearch ? "native" : "none",
				webSearch: options.webSearch ?? false,
				maxOutputTokens: API_PROVIDER_MAX_OUTPUT_TOKENS["ai-gateway"],
				locale: null,
			},
			prompt,
			AbortSignal.timeout(120_000),
		);
		const text = Buffer.from(envelope.bodyBase64, "base64").toString("utf8");
		if (envelope.status < 200 || envelope.status >= 300)
			throw new Error(`AI Gateway API error (${envelope.status}): ${text}`);
		const data = JSON.parse(text);
		warnIfOutputCapped("ai-gateway", options.version, data.stop_reason ?? data.choices?.[0]?.finish_reason);
		const extracted = extractRun(data, "ai-gateway");
		const queries = [
			...(data.output ?? []).flatMap((item: any) =>
				item.type === "web_search_call" && item.action?.type === "search"
					? [item.action.query, ...(item.action.queries ?? [])]
					: [],
			),
			...(data.content ?? []).flatMap((item: any) =>
				item.type === "server_tool_use" && item.name === "web_search" ? [item.input?.query] : [],
			),
		].filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0);
		return {
			rawOutput: data,
			webQueries: reportedWebQueries(queries, {
				webSearch: options.webSearch,
				searchProven: extracted.citations.length > 0,
			}),
			modelVersion: data.model ?? data.response?.modelId ?? options.version,
		};
	},
};

const targetFields = z
	.object({
		provider: z.literal("ai-gateway"),
		model: z
			.string()
			.regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/)
			.refine((value) => !value.endsWith("/auto") && !value.includes("latest"), "An explicit model slug is required"),
		access: z.literal("api"),
		surface: z.literal("direct_model_api"),
		webSearch: z.boolean(),
		grounding: z.enum(["none", "native"]),
		maxOutputTokens: z.number().int().min(1).max(8192),
		locale: z.null(),
	})
	.strict();
export const aiGatewayAcquisitionTargetSchema = targetFields.refine(
	(value) => value.webSearch === (value.grounding === "native"),
	"Search and grounding must agree",
);
export const historicalAcquisitionTargetSchema = targetFields
	.extend({ provider: z.literal("openrouter") })
	.refine((value) => value.webSearch === (value.grounding === "native"), "Search and grounding must agree");
export const aiGatewayHttpEnvelopeSchema = z
	.object({
		schemaVersion: z.literal("elmo.provider_http.v1"),
		url: z.enum([CHAT_URL, RESPONSES_URL, MESSAGES_URL, SDK_URL]),
		method: z.literal("POST"),
		status: z.number().int(),
		headers: z.record(z.string(), z.string()),
		bodyBase64: z.string(),
		bodySha256: z.string(),
		bodyBytes: z.number().int().nonnegative(),
	})
	.strict();
export const historicalHttpEnvelopeSchema = aiGatewayHttpEnvelopeSchema.extend({
	url: z.literal("https://openrouter.ai/api/v1/chat/completions"),
});

export async function acquireAiGatewayAnswer(
	target: z.infer<typeof aiGatewayAcquisitionTargetSchema>,
	prompt: string,
	signal: AbortSignal,
): Promise<z.infer<typeof aiGatewayHttpEnvelopeSchema>> {
	const selected = aiGatewayAcquisitionTargetSchema.parse(target);
	const request = requestBody(selected.model, prompt, selected.maxOutputTokens, selected.grounding);
	signal.throwIfAborted();
	if (request.url === SDK_URL) return acquireNativeSdkAnswer(selected, prompt, signal);
	const response = await fetch(request.url, {
		method: "POST",
		redirect: "error",
		headers: gatewayHeaders(request.url),
		signal,
		body: JSON.stringify(request.body),
	});
	const bytes = Buffer.from(await response.arrayBuffer());
	return {
		schemaVersion: "elmo.provider_http.v1",
		url: request.url as z.infer<typeof aiGatewayHttpEnvelopeSchema>["url"],
		method: "POST",
		status: response.status,
		headers: Object.fromEntries(response.headers),
		bodyBase64: bytes.toString("base64"),
		bodySha256: createHash("sha256").update(bytes).digest("hex"),
		bodyBytes: bytes.length,
	};
}

async function acquireNativeSdkAnswer(
	target: z.infer<typeof aiGatewayAcquisitionTargetSchema>,
	prompt: string,
	signal: AbortSignal,
): Promise<z.infer<typeof aiGatewayHttpEnvelopeSchema>> {
	const apiKey = getCredential("AI_GATEWAY_API_KEY");
	if (!apiKey?.trim()) throw new Error("AI_GATEWAY_API_KEY is required before Gateway dispatch");
	let captured: z.infer<typeof aiGatewayHttpEnvelopeSchema> | undefined;
	let invoked = false;
	const gateway = createGateway({
		apiKey,
		fetch: async (input, init) => {
			const url = input instanceof Request ? input.url : input.toString();
			if (invoked || url !== SDK_URL) throw new Error("Gateway native acquisition permits one exact inference request");
			signal.throwIfAborted();
			invoked = true;
			const response = await fetch(input, { ...init, redirect: "error", signal });
			const bytes = Buffer.from(await response.clone().arrayBuffer());
			captured = {
				schemaVersion: "elmo.provider_http.v1",
				url: SDK_URL,
				method: "POST",
				status: response.status,
				headers: Object.fromEntries(response.headers),
				bodyBase64: bytes.toString("base64"),
				bodySha256: createHash("sha256").update(bytes).digest("hex"),
				bodyBytes: bytes.length,
			};
			return response;
		},
	});
	try {
		await gateway(target.model).doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: prompt }] }],
			maxOutputTokens: target.maxOutputTokens,
			abortSignal: signal,
			tools: [
				{
					type: "provider",
					id: target.model.startsWith("google/") ? "google.google_search" : "xai.web_search",
					name: "web_search",
					args: {},
				},
			],
		});
	} catch (error) {
		if (!captured) throw error;
	}
	if (!captured) throw new Error("Gateway native acquisition returned no physical response");
	return captured;
}

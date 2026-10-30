/**
 * The single module that parses and formats the SCRAPE_TARGETS env var.
 *
 * Format: model:provider[:version][:online]
 * - model: AI model to track (chatgpt, google-ai-mode, copilot, etc.)
 * - provider: How to reach it (olostep, brightdata, direct, "ai-gateway": aiGateway, dataforseo)
 * - version: Specific version slug, required for direct/ai-gateway
 * - :online: Append to enable web search. Omit = no web search.
 */

import { PROVIDERS_DOCS_URL } from "./constants";

export interface ModelConfig {
	model: string;
	provider: string;
	version?: string;
	webSearch: boolean;
}

/**
 * Parse the SCRAPE_TARGETS env var into structured ModelConfig objects.
 *
 * Parsing: split on ":". First = model, second = provider. If last segment is "online",
 * pop it (websearch = true). Remaining middle segments rejoined with ":" = version slug.
 * The parser preserves version text; the selected provider owns its protocol validity.
 */
export function parseScrapeTargets(envValue?: string): ModelConfig[] {
	if (!envValue || !envValue.trim()) {
		throw new Error(
			"SCRAPE_TARGETS environment variable is required. " +
				"Set it to configure which AI models to track. Example:\n" +
				"  SCRAPE_TARGETS=chatgpt:olostep:online,google-ai-mode:olostep:online,copilot:olostep:online\n" +
				`See ${PROVIDERS_DOCS_URL} for details.`,
		);
	}
	return envValue.split(",").map((raw) => {
		const trimmed = raw.trim();
		if (!trimmed) throw new Error("Invalid SCRAPE_TARGETS: empty entry (check for trailing commas)");
		const parts = trimmed.split(":");
		if (parts.length < 2) throw new Error(`Invalid SCRAPE_TARGETS entry: "${trimmed}" (need at least model:provider)`);
		const model = parts[0];
		const provider = parts[1];
		const webSearch = parts[parts.length - 1] === "online";
		const versionParts = parts.slice(2, webSearch ? -1 : undefined);
		const version = versionParts.length > 0 ? versionParts.join(":") : undefined;
		return { model, provider, version, webSearch };
	});
}

/**
 * Inverse of parseScrapeTargets for a single entry: build the
 * model:provider[:version][:online] string from a ModelConfig.
 */
export function formatScrapeTarget(config: ModelConfig): string {
	const parts = [config.model, config.provider];
	if (config.version) parts.push(config.version);
	if (config.webSearch) parts.push("online");
	return parts.join(":");
}

/**
 * The provider:model targets shown on the public status page and exercised by
 * the scheduled test-providers workflow. Both the page and the workflow read
 * this one list so the "what we display" and "what we test" sets can't drift.
 */
export const STATUS_TARGETS = [
	"chatgpt:searchapi",
	"chatgpt:searchapi:online",
	"google-ai-mode:searchapi:online",
	"google-ai-overview:searchapi:online",
	"gemini:searchapi:online",
	"copilot:searchapi:online",
	"perplexity:searchapi:online",
	"chatgpt:olostep:online",
	"google-ai-mode:olostep:online",
	"google-ai-overview:olostep:online",
	"gemini:olostep:online",
	"copilot:olostep:online",
	"perplexity:olostep:online",
	"chatgpt:brightdata",
	"chatgpt:brightdata:online",
	"google-ai-mode:brightdata:online",
	"gemini:brightdata:online",
	"perplexity:brightdata:online",
	"copilot:brightdata:online",
	"google-ai-overview:brightdata:online",
	"chatgpt:oxylabs",
	"chatgpt:oxylabs:online",
	"google-ai-mode:oxylabs:online",
	"google-ai-overview:oxylabs:online",
	"perplexity:oxylabs:online",
	"chatgpt:cloro:online",
	"perplexity:cloro:online",
	"copilot:cloro:online",
	"gemini:cloro:online",
	"google-ai-mode:cloro:online",
	"google-ai-overview:cloro:online",
	"google-ai-mode:dataforseo:online",
	"google-ai-overview:dataforseo:online",
	"chatgpt:dataforseo:online",
	"gemini:dataforseo:online",
	"perplexity:dataforseo:online",
	// Pinning a model_name routes to LLM Responses instead of the scraper, so
	// these keep the API side of the provider monitored too.
	"chatgpt:dataforseo:gpt-5.5:online",
	"gemini:dataforseo:gemini-2.5-flash:online",
	"chatgpt:openai-api:gpt-6-luna",
	"chatgpt:openai-api:gpt-6-luna:online",
	"claude:anthropic-api:claude-haiku-5-5",
	"claude:anthropic-api:claude-haiku-5-5:online",
	"claude:ai-gateway:anthropic/claude-haiku-5.5",
	"claude:ai-gateway:anthropic/claude-haiku-5.5:online",
	"chatgpt:ai-gateway:openai/gpt-6-luna",
	"chatgpt:ai-gateway:openai/gpt-6-luna:online",
	"gemini:ai-gateway:google/gemini-2.5-flash",
	"gemini:ai-gateway:google/gemini-2.5-flash:online",
	"deepseek:ai-gateway:deepseek/deepseek-v3.2",
	"qwen:ai-gateway:qwen/qwen3-235b-a22b-2507",
	"kimi:ai-gateway:moonshotai/kimi-k2.5",
	"grok:ai-gateway:spacexai/grok-4.5",
	"grok:ai-gateway:spacexai/grok-4.5:online",
	"mistral:ai-gateway:mistralai/mistral-medium-3.1",
	// Perplexity search is performed by the selected model; no generic search is substituted.
	"perplexity:ai-gateway:perplexity/sonar:online",
	"mistral:mistral-api:mistral-medium-latest",
	"mistral:mistral-api:mistral-medium-latest:online",
];

/**
 * Which providers can serve each trackable model, derived from STATUS_TARGETS so
 * the answer is limited to combinations the scheduled provider workflow actually
 * exercises. Used to tell a self-hosted operator what they would need in order
 * to track a platform they have not configured yet.
 */
export function providersByModel(): Map<string, string[]> {
	const byModel = new Map<string, Set<string>>();
	for (const target of parseScrapeTargets(STATUS_TARGETS.join(","))) {
		const providers = byModel.get(target.model) ?? new Set<string>();
		providers.add(target.provider);
		byModel.set(target.model, providers);
	}
	return new Map([...byModel].map(([model, providers]) => [model, [...providers].sort()]));
}

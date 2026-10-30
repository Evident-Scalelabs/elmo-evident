import * as p from "@clack/prompts";
import { formatScrapeTarget } from "@workspace/config/scrape-targets";
import pc from "picocolors";
import type { EnvMap } from "./config.js";
import { providerSpec } from "./providers.js";
import { assertNotCancelled, link } from "./util.js";

const TYPESAFE_SIGNUP_URL = "https://console.typesafe.ai";
const AI_GATEWAY_SIGNUP_URL = "https://vercel.com/docs/ai-gateway/authentication-and-security/authentication";

type Gateway = "typesafe" | "ai-gateway";

export async function collectJudgeKey(env: EnvMap): Promise<void> {
	const hasAiGateway = Boolean(env.AI_GATEWAY_API_KEY?.trim());
	p.note(
		[
			"Elmo reads every answer with Jev (TypeSafe) to decide which ones really",
			"mention your brand and competitors, how they describe each, and the",
			"passage that shows it. Answers that name a tracked company are sent to",
			"Jev for this; the rest cost nothing.",
			"",
			"Very roughly $0.15–0.35 per 1,000 answers, more when answers are long or",
			"name many competitors. With the default 5 samples a day, 25 prompts on 3",
			"platforms is ~11,000 answers, about $2–4 a month; 100 prompts on 5",
			"platforms is ~75,000, about $11–26.",
			"",
			"On first start Elmo also re-judges the last 90 days of history once",
			"(REPROCESS_DAYS), about three months of the above.",
			"",
			"Jev pricing depends on the selected transport and account; verify it before",
			"paid execution. Usage is billed to the selected account.",
		].join("\n"),
		"Mention and sentiment judging",
	);
	const gateway = await p.select<Gateway>({
		message: "How should Elmo call Jev?",
		options: hasAiGateway
			? [
					{ value: "ai-gateway", label: "Through AI Gateway, with the AI Gateway key you entered above" },
					{ value: "typesafe", label: "Directly from TypeSafe, with a TypeSafe API key" },
				]
			: [
					{ value: "typesafe", label: "Directly from TypeSafe, with a TypeSafe API key" },
					{ value: "ai-gateway", label: "Through AI Gateway, with an AI Gateway API key" },
				],
		initialValue: hasAiGateway ? "ai-gateway" : "typesafe",
	});
	assertNotCancelled(gateway);

	if (gateway === "typesafe") {
		p.log.info(`Get a key: ${link(pc.cyan(TYPESAFE_SIGNUP_URL), TYPESAFE_SIGNUP_URL)}`);
		env.TYPESAFE_API_KEY = await askKey("TypeSafe API key");
		return;
	}

	if (hasAiGateway) return;
	keepOnboardingProvider(env);
	p.log.info(`Get a key: ${link(pc.cyan(AI_GATEWAY_SIGNUP_URL), AI_GATEWAY_SIGNUP_URL)}`);
	env.AI_GATEWAY_API_KEY = await askKey("AI Gateway API key (for Jev)");
}

async function askKey(message: string): Promise<string> {
	const key = await p.password({ message, validate: (value) => (value?.trim() ? undefined : "Required") });
	assertNotCancelled(key);
	return key.trim();
}

/**
 * Onboarding and the Opportunities report pick the first configured direct API, and AI Gateway
 * outranks Anthropic and Mistral, so a key added only for Jev would quietly take them over.
 */
function keepOnboardingProvider(env: EnvMap): void {
	if (env.ONBOARDING_LLM_TARGET?.trim() || env.OPENAI_API_KEY?.trim()) return;
	const current = env.ANTHROPIC_API_KEY?.trim() ? "anthropic" : env.MISTRAL_API_KEY?.trim() ? "mistral" : undefined;
	const target = current && providerSpec(current).target;
	if (target) env.ONBOARDING_LLM_TARGET = formatScrapeTarget({ ...target, webSearch: false });
}

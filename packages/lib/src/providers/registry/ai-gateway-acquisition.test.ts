import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireAiGatewayAnswer, aiGatewayAcquisitionTargetSchema } from "./ai-gateway";

vi.mock("../../secrets", () => ({ getCredential: () => "fixture-only" }));
afterEach(() => vi.unstubAllGlobals());
const target = aiGatewayAcquisitionTargetSchema.parse({
	provider: "ai-gateway",
	model: "openai/gpt-4.1",
	access: "api",
	surface: "direct_model_api",
	webSearch: true,
	grounding: "native",
	maxOutputTokens: 2048,
	locale: null,
});
const signal = () => new AbortController().signal;
describe("bounded direct AI Gateway acquisition", () => {
	it("freezes exact native grounding/output controls and retains original response bytes", async () => {
		const bytes = Buffer.from(' {"model":"served-model","choices":[{"message":{"content":"Answer"}}]}\n');
		const fetch = vi.fn(
			async (_url: unknown, _init: RequestInit) => new Response(bytes, { headers: { "x-request-id": "raw-id" } }),
		);
		vi.stubGlobal("fetch", fetch);
		const abort = signal();
		const result = await acquireAiGatewayAnswer(target, "Neutral question", abort);
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, options] = fetch.mock.calls[0];
		expect(url).toBe("https://ai-gateway.vercel.sh/v1/responses");
		expect(options.signal).toBe(abort);
		expect(JSON.parse(options.body as string)).toEqual({
			model: "openai/gpt-4.1",
			input: "Neutral question",
			max_output_tokens: 2048,
			tools: [{ type: "web_search", search_context_size: "low" }],
			tool_choice: "required",
		});
		expect(Buffer.from(result.bodyBase64, "base64")).toEqual(bytes);
		expect(result.bodySha256).toBe(createHash("sha256").update(bytes).digest("hex"));
		expect(result.bodyBytes).toBe(bytes.length);
		expect(result.headers["x-request-id"]).toBe("raw-id");
	});
	it("retains a non-JSON HTTP error without retry or alternative grounding", async () => {
		const fetch = vi.fn(async () => new Response("upstream unavailable", { status: 503 }));
		vi.stubGlobal("fetch", fetch);
		const result = await acquireAiGatewayAnswer(target, "Neutral question", signal());
		expect(result.status).toBe(503);
		expect(Buffer.from(result.bodyBase64, "base64").toString()).toBe("upstream unavailable");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("omits search tools when the frozen request disables them", async () => {
		const fetch = vi.fn(async (_url: unknown, _init: RequestInit) => Response.json({}));
		vi.stubGlobal("fetch", fetch);
		await acquireAiGatewayAnswer({ ...target, grounding: "none", webSearch: false }, "Neutral question", signal());
		expect(JSON.parse(fetch.mock.calls[0][1].body as string)).not.toHaveProperty("plugins");
	});
	it("does not retry transport uncertainty or dispatch after local cancellation", async () => {
		const fetch = vi.fn().mockRejectedValue(new Error("connection lost"));
		vi.stubGlobal("fetch", fetch);
		await expect(acquireAiGatewayAnswer(target, "Neutral question", signal())).rejects.toThrow("connection lost");
		const controller = new AbortController();
		controller.abort();
		await expect(acquireAiGatewayAnswer(target, "Neutral question", controller.signal)).rejects.toThrow();
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("rejects DFS, implicit routing, claimed locale and inconsistent grounding before purchase", () => {
		for (const patch of [
			{ provider: "dataforseo" },
			{ model: "openai/gpt-4.1:online" },
			{ model: "ai-gateway/auto" },
			{ model: "openai/latest" },
			{ locale: "en-US" },
			{ grounding: "none" },
			{ maxOutputTokens: 8193 },
		]) {
			expect(aiGatewayAcquisitionTargetSchema.safeParse({ ...target, ...patch }).success).toBe(false);
		}
	});
});

it("retains native SDK error bytes with one physical request and no automatic retry", async () => {
	const bytes = Buffer.from(" native search unavailable\n");
	const fetch = vi.fn().mockResolvedValue(new Response(bytes, { status: 503 }));
	vi.stubGlobal("fetch", fetch);
	const result = await acquireAiGatewayAnswer({ ...target, model: "google/fixture" }, "Question", signal());
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(fetch.mock.calls[0][0]).toBe("https://ai-gateway.vercel.sh/v4/ai/language-model");
	expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
		tools: [{ type: "provider", id: "google.google_search" }],
	});
	expect(result.status).toBe(503);
	expect(Buffer.from(result.bodyBase64, "base64")).toEqual(bytes);
});

it("rejects unknown native protocols rather than buying an ungrounded answer", async () => {
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	await expect(acquireAiGatewayAnswer({ ...target, model: "other/fixture" }, "Question", signal())).rejects.toThrow(
		"Native search protocol",
	);
	expect(fetch).not.toHaveBeenCalled();
});

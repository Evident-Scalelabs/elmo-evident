import { afterEach, describe, expect, it, vi } from "vitest";
import { extractRun } from "../../text-extraction";
import { aiGateway } from "./ai-gateway";

vi.mock("../../secrets", () => ({ getCredential: () => "fixture-only" }));
afterEach(() => vi.unstubAllGlobals());
describe("Gateway answer protocol", () => {
	it("keeps the configured model and native OpenAI search without router aliases", async () => {
		const fetch = vi.fn().mockResolvedValue(
			Response.json({
				model: "openai/served",
				output: [
					{
						type: "message",
						content: [
							{
								type: "output_text",
								text: "answer",
								annotations: [{ type: "url_citation", url: "https://source.example", title: "Source" }],
							},
						],
					},
				],
			}),
		);
		const inference = fetch;
		const publicCatalog = Response.json({
			data: ["openai/configured", "anthropic/configured", "provider/model"].map((id) => ({ id })),
		});
		vi.stubGlobal(
			"fetch",
			vi.fn((url, init) => (String(url).endsWith("/models") ? Promise.resolve(publicCatalog) : inference(url, init))),
		);
		const result = await aiGateway.run("chatgpt", "question", { version: "openai/configured", webSearch: true });
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0][0]).toBe("https://ai-gateway.vercel.sh/v1/responses");
		expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
			model: "openai/configured",
			tools: [{ type: "web_search" }],
		});
		expect(result.modelVersion).toBe("openai/served");
		expect(extractRun(result.rawOutput, "ai-gateway")).toMatchObject({
			textContent: "answer",
			citations: [{ url: "https://source.example" }],
		});
	});
	it("does not turn an ungrounded answer into native search evidence", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: "answer" } }] })));
		const result = await aiGateway.run("chatgpt", "question", { version: "provider/model", webSearch: false });
		expect(result.webQueries).toEqual([]);
		expect(extractRun(result.rawOutput, "ai-gateway").citations).toEqual([]);
	});
	it("uses native Anthropic blocks without a generic search substitution", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(Response.json({ model: "anthropic/served", content: [{ type: "text", text: "answer" }] }));
		const inference = fetch;
		const publicCatalog = Response.json({
			data: ["openai/configured", "anthropic/configured", "provider/model"].map((id) => ({ id })),
		});
		vi.stubGlobal(
			"fetch",
			vi.fn((url, init) => (String(url).endsWith("/models") ? Promise.resolve(publicCatalog) : inference(url, init))),
		);
		const result = await aiGateway.run("claude", "question", { version: "anthropic/configured", webSearch: true });
		expect(fetch.mock.calls[0][0]).toBe("https://ai-gateway.vercel.sh/v1/messages");
		expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ tools: [{ type: "web_search_20250305" }] });
		expect(extractRun(result.rawOutput, "ai-gateway").textContent).toBe("answer");
	});
});

it("fails unavailable exact models after free metadata and before a paid request", async () => {
	vi.resetModules();
	const fetch = vi.fn().mockResolvedValue(Response.json({ data: [{ id: "other/model" }] }));
	vi.stubGlobal("fetch", fetch);
	const { aiGateway: provider } = await import("./ai-gateway");
	await expect(provider.run("model", "Question", { version: "missing/exact-model" })).rejects.toThrow("no substitute");
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(fetch.mock.calls[0][0]).toBe("https://ai-gateway.vercel.sh/v1/models");
	expect(fetch.mock.calls[0][1].method).toBeUndefined();
});

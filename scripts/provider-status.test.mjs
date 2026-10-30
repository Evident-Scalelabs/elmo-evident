import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStatusMatrix, formatProvider, providerColumnLabel } from "../apps/www/src/lib/status-helpers.ts";

test("the status matrix includes Gateway API results and preserves historical provider columns", () => {
	const current = { target: "chatgpt:ai-gateway:openai/fixture:online", entries: [] };
	const historical = { target: "chatgpt:openrouter:openai/fixture:online", entries: [] };
	const matrix = buildStatusMatrix([current, historical]);
	assert.ok(matrix.providers.includes("ai-gateway"));
	assert.ok(matrix.providers.includes("openrouter"));
	assert.deepEqual(matrix.cell("chatgpt", "ai-gateway").targets, [current]);
	assert.deepEqual(matrix.cell("chatgpt", "openrouter").targets, [historical]);
	assert.equal(matrix.availability("copilot", "ai-gateway"), "unavailable");
	assert.equal(formatProvider("ai-gateway"), "AI Gateway");
	assert.equal(providerColumnLabel("ai-gateway", false), "AI Gateway");
});

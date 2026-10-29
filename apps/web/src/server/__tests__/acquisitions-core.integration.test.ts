import { createHash, randomUUID } from "node:crypto";
import { db } from "@workspace/lib/db/db";
import { acquisitionRequests, promptRuns, runMentions } from "@workspace/lib/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireAnswer,
	acquisitionRequestHash,
	acquisitionRequestSchema,
	readAcquisition,
} from "@/server/acquisitions-core";
import { createBrand, createPrompt, deleteBrand } from "@/test/integration/stats-fixtures";

const provider = vi.hoisted(() => ({ run: vi.fn(), configured: vi.fn(() => true) }));
vi.mock("@workspace/lib/providers", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/lib/providers")>()),
	acquireOpenrouterAnswer: provider.run,
	getProvider: () => ({ isConfigured: provider.configured }),
}));

const revision = "a".repeat(40);
const promptText = "Which example suppliers offer reusable packaging?";
function envelope(data: unknown, status = 200) {
	const bytes = Buffer.from(JSON.stringify(data));
	return {
		schemaVersion: "elmo.provider_http.v1",
		url: "https://openrouter.ai/api/v1/chat/completions",
		method: "POST",
		status,
		headers: { "content-type": "application/json" },
		bodyBase64: bytes.toString("base64"),
		bodyBytes: bytes.length,
		bodySha256: createHash("sha256").update(bytes).digest("hex"),
	};
}
const rawOutput = envelope({
	model: "provider-reported-model",
	choices: [{ message: { content: "Example answer", annotations: [] } }],
});

let brandId: string;
let promptId: string;
const requestIds: string[] = [];

function request() {
	const requestId = randomUUID();
	requestIds.push(requestId);
	return acquisitionRequestSchema.parse({
		schemaVersion: "elmo.acquisition.request.v1",
		requestId,
		expectedProducerRevision: revision,
		promptId,
		brandId,
		prompt: promptText,
		target: {
			provider: "openrouter",
			model: "openai/gpt-4.1",
			access: "api",
			surface: "direct_model_api",
			webSearch: true,
			grounding: "native",
			maxOutputTokens: 2048,
			locale: null,
		},
		deadlineAt: new Date(Date.now() + 600_000).toISOString(),
	});
}

beforeAll(async () => {
	brandId = await createBrand();
	promptId = await createPrompt(brandId, { value: promptText, enabled: false });
});
beforeEach(() => {
	vi.stubEnv("ELMO_ACQUISITION_SOURCE_REVISION", revision);
	provider.configured.mockReturnValue(true);
	provider.run.mockResolvedValue(rawOutput);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	provider.run.mockReset();
});
afterAll(async () => {
	await db.delete(acquisitionRequests).where(inArray(acquisitionRequests.id, requestIds));
	await deleteBrand(brandId);
});

describe("bounded explicit acquisition", () => {
	it("reserves before dispatch and lets concurrent replay read without a second purchase or judging", async () => {
		const input = request();
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		provider.run.mockImplementation(async () => {
			entered();
			await blocked;
			return rawOutput;
		});
		const first = acquireAnswer(input);
		await started;
		expect(await acquireAnswer(input)).toMatchObject({ status: "dispatching", run: null });
		release();
		const completed = await first;
		expect(completed).toMatchObject({
			status: "completed",
			request: input,
			requestHash: acquisitionRequestHash(input),
			producerRevision: revision,
			effectiveTarget: { servedModel: "provider-reported-model", servedModelSource: "provider_reported" },
			run: {
				id: input.requestId,
				rawOutput,
				retained: true,
				answer: { text: "Example answer", extractionStatus: "available" },
			},
		});
		expect(await readAcquisition(input.requestId)).toEqual(completed);
		expect(await acquireAnswer(input)).toEqual(completed);
		expect(await db.select().from(runMentions).where(eq(runMentions.runId, input.requestId))).toEqual([]);
		expect(provider.run).toHaveBeenCalledTimes(1);
		await expect(acquireAnswer({ ...input, prompt: "Different prompt" })).rejects.toMatchObject({ status: 409 });
	});

	it("retains an uncertain purchase and never re-dispatches it after timeout or expiry", async () => {
		const input = request();
		provider.run.mockRejectedValue(new Error("connection lost after send"));
		expect(await acquireAnswer(input)).toMatchObject({ status: "unknown_after_dispatch", run: null });
		vi.spyOn(Date, "now").mockReturnValue(Date.parse(input.deadlineAt) + 1);
		expect(await acquireAnswer(input)).toMatchObject({ status: "unknown_after_dispatch" });
		expect(await readAcquisition(input.requestId)).toMatchObject({ status: "unknown_after_dispatch" });
		expect(provider.run).toHaveBeenCalledTimes(1);
	});

	it("keeps provider HTTP errors as raw source with unknown model, without inventing an answer", async () => {
		const input = request();
		const failed = envelope({ error: { message: "Native search unavailable" } }, 400);
		provider.run.mockResolvedValue(failed);
		expect(await acquireAnswer(input)).toMatchObject({
			status: "completed",
			effectiveTarget: { servedModel: null, servedModelSource: "unknown" },
			run: {
				retained: true,
				rawOutput: failed,
				providerHttpStatus: 400,
				answer: { text: null, extractionStatus: "no_answer" },
			},
		});
	});

	it("returns the paid payload with a persistence gap when the raw write fails", async () => {
		const input = request();
		await db.execute(
			sql`CREATE FUNCTION reject_acquisition_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture persistence failure'; END; $$`,
		);
		await db.execute(
			sql.raw(
				`CREATE TRIGGER reject_acquisition_fixture BEFORE INSERT ON prompt_runs FOR EACH ROW WHEN (NEW.id = '${input.requestId}'::uuid) EXECUTE FUNCTION reject_acquisition_fixture()`,
			),
		);
		try {
			expect(await acquireAnswer(input)).toMatchObject({
				status: "retention_failed",
				run: { retained: false, rawOutput },
			});
			expect(await acquireAnswer(input)).toMatchObject({ status: "unknown_after_dispatch", run: null });
			expect(provider.run).toHaveBeenCalledTimes(1);
		} finally {
			await db.execute(sql`DROP TRIGGER reject_acquisition_fixture ON prompt_runs`);
			await db.execute(sql`DROP FUNCTION reject_acquisition_fixture()`);
		}
	});

	it("refuses wrong revision, prompt/brand, enabled prompt, unsupported source and expired new work before purchase", async () => {
		const input = request();
		await expect(acquireAnswer({ ...input, expectedProducerRevision: "b".repeat(40) })).rejects.toMatchObject({
			status: 409,
		});
		await expect(acquireAnswer({ ...input, brandId: "another-brand" })).rejects.toMatchObject({ status: 409 });
		const enabledId = await createPrompt(brandId, { value: promptText });
		await expect(acquireAnswer({ ...input, promptId: enabledId })).rejects.toMatchObject({ status: 409 });
		await expect(acquireAnswer({ ...input, deadlineAt: new Date(Date.now() - 1).toISOString() })).rejects.toMatchObject(
			{ status: 409 },
		);
		expect(acquisitionRequestSchema.safeParse({ ...input, target: { ...input.target, locale: "en-US" } }).success).toBe(
			false,
		);
		expect(
			acquisitionRequestSchema.safeParse({ ...input, target: { ...input.target, provider: "dataforseo" } }).success,
		).toBe(false);
		expect(provider.run).not.toHaveBeenCalled();
		expect(await db.select().from(promptRuns).where(eq(promptRuns.id, input.requestId))).toEqual([]);
	});
});

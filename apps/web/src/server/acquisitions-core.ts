import { createHash } from "node:crypto";
import { db } from "@workspace/lib/db/db";
import { acquisitionRequests, promptRuns, prompts } from "@workspace/lib/db/schema";
import {
	acquireOpenrouterAnswer,
	getProvider,
	openrouterAcquisitionTargetSchema,
	openrouterHttpEnvelopeSchema,
} from "@workspace/lib/providers";
import { extractRun } from "@workspace/lib/text-extraction";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError } from "@/lib/api/handler";

export const acquisitionRequestSchema = z
	.object({
		schemaVersion: z.literal("elmo.acquisition.request.v1"),
		requestId: z.guid(),
		expectedProducerRevision: z.string().regex(/^[0-9a-f]{40}$/),
		promptId: z.guid(),
		brandId: z.string().min(1).max(256),
		prompt: z
			.string()
			.min(1)
			.refine((value) => Array.from(value).length <= 500, "Maximum 500 characters"),
		target: openrouterAcquisitionTargetSchema,
		deadlineAt: z.iso.datetime(),
	})
	.strict();

type AcquisitionRequest = z.infer<typeof acquisitionRequestSchema>;
type StoredRequest = typeof acquisitionRequests.$inferSelect;
type StoredRun = typeof promptRuns.$inferSelect;

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, child]) => [key, canonical(child)]),
		);
	}
	return value;
}

export function acquisitionRequestHash(request: AcquisitionRequest): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(request)))
		.digest("hex");
}

function providerOutput(rawOutput: unknown) {
	const envelope = openrouterHttpEnvelopeSchema.safeParse(rawOutput);
	if (!envelope.success) return { envelope: null, data: null };
	const bytes = Buffer.from(envelope.data.bodyBase64, "base64");
	if (
		bytes.length !== envelope.data.bodyBytes ||
		createHash("sha256").update(bytes).digest("hex") !== envelope.data.bodySha256
	) {
		throw new Error("Acquisition provider body changed");
	}
	let data: unknown = null;
	try {
		data = JSON.parse(bytes.toString("utf8"));
	} catch {
		/* Original bytes are retained. */
	}
	return { envelope: envelope.data, data };
}

const answerMetadataSchema = z
	.object({
		model: z.string().optional(),
		choices: z
			.array(
				z
					.object({
						message: z.object({ content: z.string().nullish() }).passthrough(),
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();

function extractAnswer(raw: unknown) {
	const metadata = answerMetadataSchema.safeParse(raw).data;
	const text = metadata?.choices?.[0]?.message.content ?? null;
	try {
		const extracted = extractRun(raw, "openrouter");
		return {
			textContent: text,
			citations: extracted.citations,
			status: text ? "available" : "no_answer",
			servedModel: metadata?.model ?? null,
		};
	} catch {
		return { textContent: text, citations: [], status: "failed", servedModel: metadata?.model ?? null };
	}
}

function response(row: StoredRequest, run: StoredRun | null, retained = true) {
	const request = acquisitionRequestSchema.parse(row.request);
	if (acquisitionRequestHash(request) !== row.requestHash) throw new Error("Acquisition request changed");
	if (run && (run.id !== request.requestId || run.promptId !== request.promptId || run.brandId !== request.brandId)) {
		throw new Error("Acquisition run scope mismatch");
	}
	const provider = providerOutput(run?.rawOutput);
	const extracted = extractAnswer(provider.data);
	const servedModel = extracted.servedModel;
	return {
		schemaVersion: "elmo.acquisition.v1" as const,
		request,
		requestHash: row.requestHash,
		producerRevision: row.producerRevision,
		status: run
			? retained
				? "completed"
				: "retention_failed"
			: row.status === "unknown_after_dispatch" ||
					Math.min(Date.parse(request.deadlineAt), row.createdAt.getTime() + 120_000) <= Date.now()
				? "unknown_after_dispatch"
				: "dispatching",
		effectiveTarget: {
			...request.target,
			servedModel,
			servedModelSource: servedModel === null ? "unknown" : "provider_reported",
			localeSource: "not_controlled",
			grounded: extracted.citations.length ? true : null,
			groundingSource: extracted.citations.length ? "provider_url_citations" : "unreported",
		},
		run: run
			? {
					...run,
					retained,
					providerHttpStatus: provider.envelope?.status ?? null,
					answer: { text: extracted.textContent, extractionStatus: extracted.status },
					citations: extracted.citations,
				}
			: null,
	};
}

export async function readAcquisition(requestId: string) {
	const [row] = await db.select().from(acquisitionRequests).where(eq(acquisitionRequests.id, requestId)).limit(1);
	if (!row) return null;
	// Read the append-only source directly: paid answers must not wait for a mention judge.
	const [run] = await db.select().from(promptRuns).where(eq(promptRuns.id, requestId)).limit(1);
	return response(row, run ?? null);
}

export async function acquireAnswer(input: AcquisitionRequest, callerSignal?: AbortSignal) {
	const request = acquisitionRequestSchema.parse(input);
	const requestHash = acquisitionRequestHash(request);
	const existing = await readAcquisition(request.requestId);
	if (existing) {
		if (existing.requestHash !== requestHash)
			throw new ApiError(409, "Conflict", "Request ID belongs to another acquisition");
		return existing;
	}
	const producerRevision = await validateNewAcquisition(request, callerSignal);
	const [reserved] = await db
		.insert(acquisitionRequests)
		.values({ id: request.requestId, requestHash, request, producerRevision })
		.onConflictDoNothing()
		.returning();
	if (!reserved) {
		const raced = await readAcquisition(request.requestId);
		if (!raced || raced.requestHash !== requestHash)
			throw new ApiError(409, "Conflict", "Request ID belongs to another acquisition");
		return raced;
	}
	let rawRun: StoredRun | null = null;
	try {
		const remaining = Date.parse(request.deadlineAt) - Date.now();
		if (remaining <= 0) throw new Error("Acquisition deadline reached");
		const timeout = AbortSignal.timeout(Math.min(120_000, remaining));
		const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
		signal.throwIfAborted();
		const rawOutput = await acquireOpenrouterAnswer(request.target, request.prompt, signal);

		rawRun = {
			id: request.requestId,
			promptId: request.promptId,
			brandId: request.brandId,
			model: request.target.model,
			provider: "openrouter",
			version: "unreported",
			webSearchEnabled: request.target.webSearch,
			rawOutput,
			webQueries: [],
			createdAt: new Date(),
		};
		rawRun.version = extractAnswer(providerOutput(rawOutput).data).servedModel ?? "unreported";
		await db.insert(promptRuns).values(rawRun);
		return response(reserved, rawRun);
	} catch {
		// Timeout cannot prove the remote purchase stopped. A prior request is never dispatched again.
		await db
			.update(acquisitionRequests)
			.set({ status: "unknown_after_dispatch" })
			.where(eq(acquisitionRequests.id, request.requestId))
			.catch(() => undefined);
		// Preserve paid output for the caller's archive even if local persistence failed.
		return response({ ...reserved, status: "unknown_after_dispatch" }, rawRun, false);
	}
}

async function validateNewAcquisition(request: AcquisitionRequest, callerSignal?: AbortSignal) {
	const producerRevision = process.env.ELMO_ACQUISITION_SOURCE_REVISION ?? process.env.RAILWAY_GIT_COMMIT_SHA;
	if (producerRevision !== request.expectedProducerRevision)
		throw new ApiError(409, "Conflict", "Producer revision mismatch");
	if (!getProvider("openrouter").isConfigured())
		throw new ApiError(503, "Unavailable", "Selected provider is not configured");
	const remainingMs = Date.parse(request.deadlineAt) - Date.now();
	if (remainingMs <= 0 || callerSignal?.aborted)
		throw new ApiError(409, "Conflict", "Acquisition deadline or cancellation prevents dispatch");
	const [prompt] = await db
		.select({ value: prompts.value, enabled: prompts.enabled })
		.from(prompts)
		.where(and(eq(prompts.id, request.promptId), eq(prompts.brandId, request.brandId)))
		.limit(1);
	if (!prompt || prompt.value !== request.prompt || prompt.enabled) {
		throw new ApiError(409, "Conflict", "Acquisition requires the exact disabled prompt and brand");
	}
	const [occupied] = await db
		.select({ id: promptRuns.id })
		.from(promptRuns)
		.where(eq(promptRuns.id, request.requestId))
		.limit(1);
	if (occupied) throw new ApiError(409, "Conflict", "Request ID already identifies another run");
	return producerRevision;
}

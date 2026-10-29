import { createFileRoute } from "@tanstack/react-router";
import { createApiHandler, withMethodGuard } from "@/lib/api/handler";
import { acquireAnswer, acquisitionRequestSchema } from "@/server/acquisitions-core";

export const Route = createFileRoute("/api/v1/acquisitions/")({
	server: {
		handlers: withMethodGuard({
			POST: createApiHandler({
				adminOnly: true,
				body: acquisitionRequestSchema,
				handle: ({ body, request }) => acquireAnswer(body, request.signal),
			}),
		}),
	},
});

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ApiError, createApiHandler, withMethodGuard } from "@/lib/api/handler";
import { readAcquisition } from "@/server/acquisitions-core";

export const Route = createFileRoute("/api/v1/acquisitions/$requestId")({
	server: {
		handlers: withMethodGuard({
			GET: createApiHandler({
				adminOnly: true,
				params: z.object({ requestId: z.guid() }),
				handle: async ({ params }) => {
					const result = await readAcquisition(params.requestId);
					if (!result) throw new ApiError(404, "Not Found", "Acquisition not found");
					return result;
				},
			}),
		}),
	},
});

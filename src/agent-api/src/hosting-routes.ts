import { SEMVER, SLUG } from "@copilot-agent/contracts";
import { harnessHostingView, HttpError, hostingOverview, type HostingCatalog } from "@copilot-agent/service-defaults";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

const HarnessParams = z.object({ harness: z.string().regex(SLUG) }).strict();
const ViewQuery = z.object({ version: z.string().regex(SEMVER).optional() }).strict();

/**
 * Read-only hosting views: each harness's effective mode, placement, admission status with prerequisites, transports
 * for the calling principal, and effective ceilings. They change nothing and grant no connection.
 */
export function registerHostingRoutes(app: FastifyInstance, catalog: HostingCatalog, principalOf: (request: FastifyRequest) => string): void {
  app.get("/v1/hosting", async (request) => hostingOverview(catalog, principalOf(request)));
  app.get("/v1/hosting/:harness", async (request) => {
    const principal = principalOf(request);
    const params = HarnessParams.safeParse(request.params);
    if (!params.success) throw new HttpError(404, "harness_not_found", "The requested harness is not published.");
    const query = ViewQuery.safeParse(request.query ?? {});
    if (!query.success) throw new HttpError(400, "invalid_request", "'version' must be a published semantic version.");
    const versions = catalog.harnesses.get(params.data.harness);
    const snapshot = query.data.version === undefined ? versions?.[0] : versions?.find((v) => v.definition.version === query.data.version);
    if (!snapshot) throw new HttpError(404, "harness_not_found", "The requested harness version is not published.");
    return harnessHostingView(catalog, snapshot, principal);
  });
}

// Availability probe for official sources whose parser is not enabled yet, or whose publisher
// currently refuses automated requests. It stores no records. Its only job is an honest, dated
// freshness fact: reachable, or unavailable. Unavailable never means "no records exist".

import { type Adapter, type AdapterContext, type AdapterPage, IngestError } from "../types.ts";

export const availabilityProbeAdapter: Adapter = {
  name: "availability_probe",
  version: "1.0.0",
  // deno-lint-ignore require-yield
  async *pages(ctx: AdapterContext): AsyncGenerator<AdapterPage> {
    // A refusal or challenge surfaces as SourceUnavailableError and the run is recorded as blocked.
    await ctx.fetch({ url: ctx.source.official_url, accept: "text/html" });
    throw new IngestError(
      "parser_not_enabled",
      "publisher page is reachable; no parser is enabled for this source, so nothing was imported and no count is implied",
    );
  },
};

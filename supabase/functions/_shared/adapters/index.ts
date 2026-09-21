import type { Adapter } from "../types.ts";
import { availabilityProbeAdapter } from "./availability_probe.ts";
import { billsAdapter } from "./bills.ts";
import { ELECTION_LIVE_ADAPTERS } from "./election/live.ts";
import { mpDirectoryAdapter } from "./mp_directory.ts";
import { PARLIAMENT_LIVE_ADAPTERS } from "./parliament/live/index.ts";
import { releasesRssAdapter } from "./releases_rss.ts";

/**
 * Every adapter the Edge Function and the CLI can run. The family adapters live beside the core ones so a scheduled
 * run finds them in the function bundle. Statistics sources are absent on purpose: their publisher files are larger
 * than the function budget, so they run from the CLI only (adapter name "stats_family_fetch"; see CLI_ONLY_ADAPTERS).
 */
export const LIVE_ADAPTERS: { [name: string]: Adapter } = {
  [mpDirectoryAdapter.name]: mpDirectoryAdapter,
  [billsAdapter.name]: billsAdapter,
  [releasesRssAdapter.name]: releasesRssAdapter,
  [availabilityProbeAdapter.name]: availabilityProbeAdapter,
  ...PARLIAMENT_LIVE_ADAPTERS,
  ...ELECTION_LIVE_ADAPTERS,
};

/** Adapter names that are real but never run inside the Edge Function. A schedule may not name a source that uses one. */
export const CLI_ONLY_ADAPTERS: ReadonlySet<string> = new Set(["stats_family_fetch"]);

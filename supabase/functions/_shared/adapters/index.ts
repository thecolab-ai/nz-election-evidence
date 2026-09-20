import type { Adapter } from "../types.ts";
import { availabilityProbeAdapter } from "./availability_probe.ts";
import { billsAdapter } from "./bills.ts";
import { mpDirectoryAdapter } from "./mp_directory.ts";
import { releasesRssAdapter } from "./releases_rss.ts";

export const LIVE_ADAPTERS: { [name: string]: Adapter } = {
  [mpDirectoryAdapter.name]: mpDirectoryAdapter,
  [billsAdapter.name]: billsAdapter,
  [releasesRssAdapter.name]: releasesRssAdapter,
  [availabilityProbeAdapter.name]: availabilityProbeAdapter,
};

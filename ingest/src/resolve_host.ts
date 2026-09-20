// Hostname resolution for the fetch guard's public-address check: an allowlisted NAME must still resolve to public
// addresses, so neither a poisoned record nor a split-horizon resolver can point a run at a private network.
import { lookup } from "node:dns/promises";

export const resolveHost = async (hostname: string): Promise<string[]> => (await lookup(hostname, { all: true })).map((entry) => entry.address);

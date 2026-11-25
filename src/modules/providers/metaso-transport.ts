import { Agent } from 'undici';

// The production container cannot route to Metaso's IPv6 address. Its default
// address-family fallback can cut off IPv4 before the connection is ready.
export const metasoMiniMaxDispatcher = new Agent({
  connect: { family: 4, timeout: 12_000 },
  headersTimeout: 10 * 60_000,
  bodyTimeout: 10 * 60_000,
});

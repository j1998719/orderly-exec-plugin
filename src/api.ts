/**
 * Client for the blockfill execution backend (blockfill-server, Execution mode).
 *
 * Auth: the trader's wallet signs a server challenge (EIP-191) once; the server
 * recovers the signer, derives the Orderly account_id, and issues a short-lived
 * Bearer session. Orders then authenticate with that session — the executing
 * account comes from the signature, so a trader always trades their OWN account.
 * (A static-key fallback via `globalThis` remains for local/demo harnesses.)
 */

/**
 * blockfill-server base URL, from `globalThis.BLOCKFILL_SERVER_URL`. Resolved at
 * CALL time (the host page sets the global after this module is imported).
 */
function blockfillServerUrl(): string {
  return (globalThis as any).BLOCKFILL_SERVER_URL ?? "https://exec.blockfill.example";
}

export type Strategy = "MAKER" | "TAKER";

export interface Session {
  token: string;
  account_id: string;
  expires_at: number;
}

/**
 * Sign a message with the connected wallet via EIP-191 `personal_sign`. Uses the
 * injected EIP-1193 provider (MetaMask & most browser wallets).
 * TODO(walletconnect): route through the Orderly wallet-connector for non-injected wallets.
 */
async function personalSign(message: string, address: string): Promise<string> {
  const eth = (globalThis as any).ethereum;
  if (!eth?.request) throw new Error("no injected wallet available to sign");
  return await eth.request({ method: "personal_sign", params: [message, address] });
}

const sessionCache = new Map<string, Session>();

/**
 * Establish (or reuse a cached) wallet-signature session for `address` under
 * `brokerId`. Prompts one wallet signature on first use / after expiry.
 */
export async function getSession(brokerId: string, address: string): Promise<Session> {
  const key = `${brokerId}:${address.toLowerCase()}`;
  const cached = sessionCache.get(key);
  if (cached && cached.expires_at - Date.now() > 60_000) return cached;

  const base = blockfillServerUrl();
  const chRes = await fetch(`${base}/execution/v1/auth/challenge`);
  if (!chRes.ok) throw new Error(`auth/challenge ${chRes.status}`);
  const challenge = (await chRes.json()) as { nonce: string; message: string };

  const signature = await personalSign(challenge.message, address);

  const res = await fetch(`${base}/execution/v1/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ broker_id: brokerId, nonce: challenge.nonce, signature }),
  });
  if (!res.ok) throw new Error(`auth/session ${res.status}: ${await res.text()}`);
  const session = (await res.json()) as Session;
  sessionCache.set(key, session);
  return session;
}

export interface PlaceTicketParams {
  exchange: "orderly";
  /** Orderly-native symbol, e.g. "PERP_ETH_USDC" (matches the server instrument cache). */
  symbol: string;
  /** Absolute target position (executor computes the delta to trade). */
  target_position: number;
  /** Execution deadline in ms (0 = immediate / market). */
  time_constraint_ms: number;
  /** Execution-style hint. NOTE: not yet in the server ticket schema (TODO §5). */
  strategy?: Strategy;
}

export interface PlaceTicketResponse {
  ticket_id: string;
  start_time_ms: number;
  status: string;
}

/**
 * POST /execution/v1/tickets/placeTicket. With a `session`, authenticates via the
 * Bearer token (account_id derived server-side from the wallet signature).
 * Without one, falls back to the static `globalThis` key (demo/local only).
 */
export async function placeTicket(
  params: PlaceTicketParams,
  session?: Session,
): Promise<PlaceTicketResponse> {
  const qs = new URLSearchParams({
    exchange: params.exchange,
    symbol: params.symbol,
    target_position: String(params.target_position),
    time_constraint_ms: String(params.time_constraint_ms),
    ...(params.strategy ? { strategy: params.strategy } : {}),
  });

  const headers: Record<string, string> = session?.token
    ? { Authorization: `Bearer ${session.token}` }
    : {
        "X-API-Key": (globalThis as any).BLOCKFILL_SESSION_TOKEN ?? "",
        "X-User-Id": (globalThis as any).BLOCKFILL_USER_ID ?? "",
      };

  const res = await fetch(
    `${blockfillServerUrl()}/execution/v1/tickets/placeTicket?${qs.toString()}`,
    { method: "POST", headers },
  );

  if (!res.ok) {
    throw new Error(`placeTicket ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as PlaceTicketResponse;
}

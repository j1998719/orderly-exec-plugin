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
 * Minimal EIP-1193 provider. The caller passes the provider of the wallet the
 * trader actually connected (from the Orderly wallet connector), so every
 * supported wallet works — not just an injected browser extension.
 */
export interface WalletProvider {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
}

/** Sign a message with the connected wallet via EIP-191 `personal_sign`. */
async function personalSign(
  provider: WalletProvider,
  message: string,
  address: string,
): Promise<string> {
  return await provider.request({ method: "personal_sign", params: [message, address] });
}

const sessionCache = new Map<string, Session>();

/**
 * Establish (or reuse a cached) wallet-signature session for `address` under
 * `brokerId`. Prompts one wallet signature on first use / after expiry.
 */
export async function getSession(
  brokerId: string,
  address: string,
  chainId: number,
  provider: WalletProvider,
): Promise<Session> {
  const key = `${brokerId}:${address.toLowerCase()}`;
  const cached = sessionCache.get(key);
  if (cached && cached.expires_at - Date.now() > 60_000) return cached;

  const base = blockfillServerUrl();
  // The challenge is a SIWE (EIP-4361) message naming this wallet, chain and the
  // site's origin, so the wallet can show the trader exactly what they authorize.
  const q = new URLSearchParams({ address, chain_id: String(chainId) });
  const chRes = await fetch(`${base}/execution/v1/auth/challenge?${q}`);
  if (!chRes.ok) throw new Error(`auth/challenge ${chRes.status}`);
  const challenge = (await chRes.json()) as { nonce: string; message: string };

  const signature = await personalSign(provider, challenge.message, address);

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

/** Sign EIP-712 typed data with the connected wallet (eth_signTypedData_v4). */
async function signTypedDataV4(
  provider: WalletProvider,
  address: string,
  typedData: unknown,
): Promise<string> {
  return await provider.request({
    method: "eth_signTypedData_v4",
    params: [address, JSON.stringify(typedData)],
  });
}

/** Whether this session's account already has a live delegated key on the executor. */
export async function isOnboarded(session: Session): Promise<boolean> {
  const res = await fetch(`${blockfillServerUrl()}/execution/v1/onboard/status`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  if (!res.ok) return false;
  return ((await res.json()) as { onboarded?: boolean }).onboarded === true;
}

/**
 * One-time delegated-key onboarding: the trader signs an AddOrderlyKey EIP-712
 * so the executor can trade their account. Prompts one `eth_signTypedData_v4`.
 * The executor hot-onboards the account within ~60s afterwards.
 */
export async function onboard(
  session: Session,
  brokerId: string,
  address: string,
  chain_id: number,
  provider: WalletProvider,
): Promise<void> {
  const base = blockfillServerUrl();
  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` };

  const prep = await fetch(`${base}/execution/v1/onboard/prepare`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ wallet_address: address, broker_id: brokerId, chain_id }),
  });
  if (!prep.ok) throw new Error(`onboard/prepare ${prep.status}: ${await prep.text()}`);
  const { typed_data, registration_typed_data } = (await prep.json()) as {
    typed_data: unknown;
    registration_typed_data?: unknown;
  };

  // Brand-new wallet with no Orderly account: register it first (extra signature).
  let registration_signature: string | undefined;
  if (registration_typed_data) {
    registration_signature = await signTypedDataV4(provider, address, registration_typed_data);
  }
  const signature = await signTypedDataV4(provider, address, typed_data);

  const comp = await fetch(`${base}/execution/v1/onboard/complete`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ signature, registration_signature }),
  });
  if (!comp.ok) throw new Error(`onboard/complete ${comp.status}: ${await comp.text()}`);
}

export interface TicketProgress {
  ticket_id: string;
  symbol: string;
  target_position: number;
  init_position: number;
  executed_position: number;
  status: string;
}

/** Fetch one ticket so the panel can show how far execution has got. */
export async function queryTicket(
  ticketId: string,
  session?: Session,
): Promise<TicketProgress | null> {
  const qs = new URLSearchParams({ exchange: "orderly", ticket_id: ticketId });
  const res = await fetch(
    `${blockfillServerUrl()}/execution/v1/tickets/queryAllTickets?${qs}`,
    { headers: authHeaders(session) },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { tickets?: TicketProgress[] };
  return body.tickets?.find((t) => t.ticket_id === ticketId) ?? null;
}

/** Bearer session when we have one, else the static demo/local key. */
function authHeaders(session?: Session): Record<string, string> {
  return session?.token
    ? { Authorization: `Bearer ${session.token}` }
    : {
        "X-API-Key": (globalThis as any).BLOCKFILL_SESSION_TOKEN ?? "",
        "X-User-Id": (globalThis as any).BLOCKFILL_USER_ID ?? "",
      };
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

  const res = await fetch(
    `${blockfillServerUrl()}/execution/v1/tickets/placeTicket?${qs.toString()}`,
    { method: "POST", headers: authHeaders(session) },
  );

  if (!res.ok) {
    throw new Error(`placeTicket ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as PlaceTicketResponse;
}

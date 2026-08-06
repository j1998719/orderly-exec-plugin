/**
 * Client for the blockfill execution backend (blockfill-server, Execution mode).
 *
 * Auth: the trader signs `AddOrderlyKey` once, delegating a scoped trading key
 * to the executor. Orderly verifies that signature, and the server returns a
 * Bearer token in the same response; orders then authenticate with the token, so
 * a trader always trades their OWN account. (A static-key fallback via
 * `globalThis` remains for local/demo harnesses.)
 *
 * There used to be a SIWE sign-in in front of this, so the trader signed twice:
 * once to log in, once to delegate. The delegation proves everything the login
 * did — Orderly rejects an `AddOrderlyKey` that did not come from the wallet —
 * so the login was asking for a signature to establish a fact the next
 * signature established anyway. One prompt now, and it is the one that
 * describes what the trader is actually agreeing to.
 *
 * Note the trader's own Orderly key never leaves the browser. We do not receive
 * a credential; we ask for one to be issued to us.
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

const sessionCache = new Map<string, Session>();

function sessionKey(brokerId: string, address: string): string {
  return `${brokerId}:${address.toLowerCase()}`;
}

/**
 * Sessions also survive a reload in `localStorage`.
 *
 * In memory alone they did not: a TWAP keeps working server-side while the tab
 * is closed, so after a refresh the trader still has live orders — but with an
 * empty cache every read-only call went out unauthenticated and the history
 * came back empty, which reads as "you have no orders". The token is a
 * short-lived Bearer scoped to one account, the same class of secret the SDK
 * already keeps there for its own trading key.
 */
const SESSION_STORE_PREFIX = "blockfill.session.";

function storage(): Storage | undefined {
  // Undefined during SSR, and access can throw when cookies are blocked.
  try {
    return (globalThis as any).localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function isLive(session?: Session): boolean {
  return !!session?.token && session.expires_at - Date.now() > 60_000;
}

function rememberSession(key: string, session: Session): void {
  sessionCache.set(key, session);
  try {
    storage()?.setItem(SESSION_STORE_PREFIX + key, JSON.stringify(session));
  } catch {
    /* storage full or blocked — the in-memory cache still works this session */
  }
}

function recallSession(key: string): Session | undefined {
  const store = storage();
  if (!store) return undefined;
  try {
    const raw = store.getItem(SESSION_STORE_PREFIX + key);
    if (!raw) return undefined;
    const session = JSON.parse(raw) as Session;
    if (isLive(session)) return session;
    store.removeItem(SESSION_STORE_PREFIX + key);
  } catch {
    /* unparseable — treat as absent */
  }
  return undefined;
}

/**
 * The current session, if one is still valid. Unlike `getSession` this never
 * asks the wallet to sign — use it for read-only calls, which must not pop a
 * signature request.
 */
export function peekSession(brokerId: string, address: string): Session | undefined {
  const key = sessionKey(brokerId, address);
  const cached = sessionCache.get(key);
  if (isLive(cached)) return cached;

  const stored = recallSession(key);
  if (stored) sessionCache.set(key, stored);
  return stored;
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

/**
 * Authorize smart execution for `address` under `brokerId`, reusing a stored
 * token when there is one.
 *
 * On first use this prompts one `eth_signTypedData_v4`: an `AddOrderlyKey`
 * delegating a `read,trading` key to the executor. That is the only signature —
 * it is what lets the executor keep working a TWAP after the tab closes, and,
 * because Orderly validates it against the wallet, it is also what authenticates
 * the trader to us. The token it returns carries that proof forward.
 *
 * A brand-new wallet with no Orderly account signs a `Registration` too; Orderly
 * requires it before it will accept any key, so the trader can go from a fresh
 * wallet to trading without leaving the panel.
 *
 * The executor hot-onboards the account within ~60s of this returning.
 */
export async function authorize(
  brokerId: string,
  address: string,
  chain_id: number,
  provider: WalletProvider,
): Promise<Session> {
  const key = sessionKey(brokerId, address);
  const cached = peekSession(brokerId, address);
  if (cached) return cached;

  const base = blockfillServerUrl();
  const json = { "Content-Type": "application/json" };

  const prep = await fetch(`${base}/execution/v1/onboard/prepare`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ wallet_address: address, broker_id: brokerId, chain_id }),
  });
  if (!prep.ok) throw new Error(`onboard/prepare ${prep.status}: ${await prep.text()}`);
  const { typed_data, registration_typed_data } = (await prep.json()) as {
    typed_data: unknown;
    registration_typed_data?: unknown;
  };

  let registration_signature: string | undefined;
  if (registration_typed_data) {
    registration_signature = await signTypedDataV4(provider, address, registration_typed_data);
  }
  const signature = await signTypedDataV4(provider, address, typed_data);

  const comp = await fetch(`${base}/execution/v1/onboard/complete`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      wallet_address: address,
      broker_id: brokerId,
      signature,
      registration_signature,
    }),
  });
  if (!comp.ok) throw new Error(`onboard/complete ${comp.status}: ${await comp.text()}`);
  const { account_id, token, token_expires_at_ms } = (await comp.json()) as {
    account_id: string;
    token: string;
    token_expires_at_ms: number;
  };

  const session: Session = { token, account_id, expires_at: token_expires_at_ms };
  rememberSession(key, session);
  return session;
}

export interface TicketProgress {
  ticket_id: string;
  symbol: string;
  target_position: number;
  init_position: number;
  executed_position: number;
  status: string;
  start_time_ms: number;
  time_constraint_ms: number;
  /** Last state change — for a finished ticket, when it ended. */
  last_update_time_ms: number;
  cancel_reason?: string | null;
  /**
   * Set once the execution window has elapsed. The engine keeps working the
   * ticket by design, so this does NOT mean the order is finished — only
   * `status` reaching a terminal value does.
   */
  is_expired?: boolean;
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

/**
 * The account's in-flight ticket for a symbol, if any.
 *
 * A TWAP keeps working after the page is closed, so on mount the panel asks
 * whether one is already running rather than showing nothing until the trader
 * places another.
 */
export async function queryOpenTicket(
  symbol: string,
  session?: Session,
): Promise<TicketProgress | null> {
  const qs = new URLSearchParams({ exchange: "orderly", symbol });
  const res = await fetch(
    `${blockfillServerUrl()}/execution/v1/tickets/queryOpenTickets?${qs}`,
    { headers: authHeaders(session) },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { tickets?: TicketProgress[] };
  return body.tickets?.[0] ?? null;
}

/** Stop a working ticket. It keeps whatever has already filled. */
export async function cancelTicket(ticketId: string, session?: Session): Promise<void> {
  const qs = new URLSearchParams({ exchange: "orderly", ticket_id: ticketId });
  const res = await fetch(
    `${blockfillServerUrl()}/execution/v1/tickets/cancelTicket?${qs}`,
    { method: "DELETE", headers: authHeaders(session) },
  );
  if (!res.ok) throw new Error(`cancelTicket ${res.status}: ${await res.text()}`);
}

/**
 * Thrown when a call needs an account and there is no session to name one.
 * A distinct type so the UI can offer to sign in instead of reporting an
 * error — or worse, rendering an empty list as "you have no orders".
 */
export class NotSignedInError extends Error {
  constructor() {
    super("not signed in");
    this.name = "NotSignedInError";
  }
}

/**
 * This account's tickets, newest first — the TWAP order history.
 *
 * Throws rather than returning `[]` on failure: an empty list is a real answer
 * ("no orders yet") and must not be indistinguishable from a failed request.
 */
export async function queryTickets(session?: Session, limit = 50): Promise<TicketProgress[]> {
  const qs = new URLSearchParams({ exchange: "orderly", limit: String(limit) });
  const res = await fetch(
    `${blockfillServerUrl()}/execution/v1/tickets/queryAllTickets?${qs}`,
    { headers: authHeaders(session) },
  );
  if (!res.ok) throw new Error(`queryAllTickets ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { tickets?: TicketProgress[] };
  return (body.tickets ?? []).sort((a, b) => b.start_time_ms - a.start_time_ms);
}

/** Bearer session when we have one, else the static demo/local key. */
function authHeaders(session?: Session): Record<string, string> {
  if (session?.token) return { Authorization: `Bearer ${session.token}` };
  const key = (globalThis as any).BLOCKFILL_SESSION_TOKEN ?? "";
  const user = (globalThis as any).BLOCKFILL_USER_ID ?? "";
  if (!key || !user) throw new NotSignedInError();
  return { "X-API-Key": key, "X-User-Id": user };
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

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

/** Sign EIP-712 typed data with the connected wallet (eth_signTypedData_v4). */
async function signTypedDataV4(address: string, typedData: unknown): Promise<string> {
  const eth = (globalThis as any).ethereum;
  if (!eth?.request) throw new Error("no injected wallet available to sign");
  return await eth.request({
    method: "eth_signTypedData_v4",
    params: [address, JSON.stringify(typedData)],
  });
}

/** The wallet's current chain id (decimal). Drives testnet vs mainnet Orderly. */
async function walletChainId(): Promise<number> {
  const eth = (globalThis as any).ethereum;
  const hex: string = await eth.request({ method: "eth_chainId" });
  return parseInt(hex, 16);
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
export async function onboard(session: Session, brokerId: string, address: string): Promise<void> {
  const base = blockfillServerUrl();
  const chain_id = await walletChainId();
  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` };

  const prep = await fetch(`${base}/execution/v1/onboard/prepare`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ wallet_address: address, broker_id: brokerId, chain_id }),
  });
  if (!prep.ok) throw new Error(`onboard/prepare ${prep.status}: ${await prep.text()}`);
  const { typed_data } = (await prep.json()) as { typed_data: unknown };

  const signature = await signTypedDataV4(address, typed_data);

  const comp = await fetch(`${base}/execution/v1/onboard/complete`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ signature }),
  });
  if (!comp.ok) throw new Error(`onboard/complete ${comp.status}: ${await comp.text()}`);
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

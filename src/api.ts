/**
 * Client for the blockfill execution backend (blockfill-server, Execution mode).
 *
 * The plugin runs inside a third-party DEX page and calls our hosted backend
 * cross-origin. Auth is currently a placeholder — per spec §7 Screen 4 / Open
 * Decisions, this must become a short-lived, wallet-signed **session token**
 * rather than a static API key embedded in public page JS.
 */

/** blockfill-server base URL (configure per deployment). */
const BLOCKFILL_SERVER_URL =
  (globalThis as any).BLOCKFILL_SERVER_URL ?? "https://exec.blockfill.example";

export type Strategy = "MAKER" | "TAKER";

export interface PlaceTicketParams {
  exchange: "orderly";
  /** BASE-QUOTE, e.g. "ETH-USDC" (executor parses leniently). */
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

/** POST /execution/v1/tickets/placeTicket */
export async function placeTicket(
  params: PlaceTicketParams,
): Promise<PlaceTicketResponse> {
  const qs = new URLSearchParams({
    exchange: params.exchange,
    symbol: params.symbol,
    target_position: String(params.target_position),
    time_constraint_ms: String(params.time_constraint_ms),
    ...(params.strategy ? { strategy: params.strategy } : {}),
  });

  const res = await fetch(
    `${BLOCKFILL_SERVER_URL}/execution/v1/tickets/placeTicket?${qs.toString()}`,
    {
      method: "POST",
      headers: {
        // TODO(auth): exchange a wallet-signed challenge for a short-lived session
        // token (POST /execution/v1/auth/session) and send it as a Bearer token
        // instead of a static X-API-Key. See spec §7 / Open Decisions.
        "X-API-Key": (globalThis as any).BLOCKFILL_SESSION_TOKEN ?? "",
        "X-User-Id": (globalThis as any).BLOCKFILL_USER_ID ?? "",
      },
    },
  );

  if (!res.ok) {
    throw new Error(`placeTicket ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as PlaceTicketResponse;
}

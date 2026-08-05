/**
 * Bot panel — the tab we add to the host's data list.
 *
 * The host's own tabs (Pending, Filled, Order history …) only know about
 * exchange orders, so a TWAP appears there as its individual child fills with
 * nothing tying them to the order that produced them. This lists the tickets
 * themselves, split the way an algo order is actually managed:
 *
 *   Running  — still working; the only thing you can act on (End)
 *   History  — finished, with how much of it filled and why it stopped
 *
 * TWAP sits under a strategy row because the panel is "Bot", not "TWAP": more
 * strategies land beside it later and the layout should not have to change.
 */
import * as React from "react";
import { useAccount, useConfig, useWalletConnector } from "@orderly.network/hooks";

import {
  cancelTicket,
  getSession,
  peekSession,
  queryTickets,
  NotSignedInError,
  type Session,
  type TicketProgress,
} from "./api.js";

/** Statuses a ticket can no longer leave. Everything else is still working. */
const TERMINAL = ["COMPLETE", "CANCEL", "EXPIRED"];
const POLL_SECONDS = 5;

const STATUS_LABEL: Record<string, string> = {
  NEW: "Pending",
  OPEN: "Running",
  COMPLETE: "Finished",
  CANCEL: "Ended",
  EXPIRED: "Expired",
};

/**
 * Why a ticket stopped, said the way a trader would.
 *
 * The API's own words are the engine's ("external" means the account owner
 * called cancel) and reading them as-is leaves a trader guessing whether they
 * or the system stopped their order.
 */
const CANCEL_REASON_LABEL: Record<string, string> = {
  external: "by you",
  superseded: "replaced by a newer order",
  paused: "paused",
  insufficient_margin: "insufficient margin",
  canceled_by_system: "by the system",
};

function qty(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(6)));
}

function stamp(ms?: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

/** "PERP_ETH_USDC" → "ETH-PERP", the name this market carries everywhere else. */
function pair(symbol: string): string {
  const base = symbol.split("_")[1];
  return base ? `${base}-PERP` : symbol;
}

function baseAsset(symbol: string): string {
  return symbol.split("_")[1] ?? "";
}

function progressOf(t: TicketProgress) {
  const total = Math.abs(t.target_position - t.init_position);
  const done = Math.abs(t.executed_position);
  return { total, done, pct: total > 0 ? Math.min(100, (done / total) * 100) : 0 };
}

/** Percentage with the filled bar under it, as in the reference design. */
function Filled({ pct }: { pct: number }) {
  return (
    <div className="oui-flex oui-flex-col oui-gap-1 oui-min-w-[64px]">
      <span className="oui-tabular-nums">{pct.toFixed(2)}%</span>
      <span className="oui-h-[3px] oui-w-full oui-rounded oui-bg-base-5">
        <span
          className="oui-block oui-h-[3px] oui-rounded oui-bg-success"
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="oui-whitespace-nowrap oui-px-3 oui-py-2 oui-text-left oui-font-normal">
      {children}
    </th>
  );
}

function Td({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <td
      className={`oui-whitespace-nowrap oui-px-3 oui-py-2 ${
        muted ? "oui-text-base-contrast-54" : ""
      }`}
    >
      {children}
    </td>
  );
}

/**
 * The ticket id, shortened but copyable in full — it is what a trader quotes
 * when asking about an order, so truncating it without a way back is useless.
 */
function TicketId({ id }: { id: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      title={`${id} (click to copy)`}
      className="oui-font-mono oui-text-base-contrast-54 hover:oui-text-base-contrast"
      onClick={() => {
        navigator.clipboard?.writeText(id).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => undefined,
        );
      }}
    >
      {copied ? "copied" : `${id.slice(0, 10)}…${id.slice(-4)}`}
    </button>
  );
}

function Direction({ t }: { t: TicketProgress }) {
  const isBuy = t.target_position >= t.init_position;
  return (
    <span className={isBuy ? "oui-text-success" : "oui-text-danger"}>
      {isBuy ? "Buy" : "Sell"}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="oui-px-3 oui-py-8 oui-text-center oui-text-xs oui-text-base-contrast-36">
      {children}
    </div>
  );
}

export function BotPanel({ symbol }: { symbol?: string }) {
  const [rows, setRows] = React.useState<TicketProgress[] | null>(null);
  const [view, setView] = React.useState<"running" | "history">("running");
  const [onlyThisPair, setOnlyThisPair] = React.useState(false);
  const [countdown, setCountdown] = React.useState(POLL_SECONDS);
  const [needsSignIn, setNeedsSignIn] = React.useState(false);
  const [error, setError] = React.useState("");

  const { state } = useAccount();
  const brokerId = useConfig<string>("brokerId");
  const address = state?.address;
  const { wallet, connectedChain } = useWalletConnector();

  // Read-only: an existing session only. Looking at your own orders must never
  // pop a wallet signature — signing in is an explicit button below.
  const [session, setSession] = React.useState<Session | undefined>();
  React.useEffect(() => {
    setSession(address && brokerId ? peekSession(brokerId, address) : undefined);
  }, [address, brokerId]);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await queryTickets(session);
        if (cancelled) return;
        setRows(list);
        setNeedsSignIn(false);
        setError("");
      } catch (e: any) {
        if (cancelled) return;
        // No session is not a failure — it is a state with an action attached.
        if (e instanceof NotSignedInError) setNeedsSignIn(true);
        else setError(e?.message ?? String(e));
        setRows(null);
      } finally {
        if (!cancelled) setCountdown(POLL_SECONDS);
      }
    };
    load();
    // Running tickets change while the panel is open.
    const poll = setInterval(load, POLL_SECONDS * 1000);
    const tick = setInterval(() => setCountdown((s) => (s > 1 ? s - 1 : s)), 1000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [session]);

  async function signIn() {
    setError("");
    try {
      const chainId = connectedChain?.id ? Number(connectedChain.id) : undefined;
      const provider = wallet?.provider as any;
      if (!address || !brokerId || !provider || !chainId) {
        throw new Error("Connect your wallet and enable trading first");
      }
      setSession(await getSession(brokerId, address, chainId, provider));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function end(ticketId: string) {
    setError("");
    try {
      await cancelTicket(ticketId, session);
    } catch (e: any) {
      setError(`Could not end ${ticketId.slice(0, 10)}…: ${e?.message ?? e}`);
    }
  }

  const visible = (rows ?? [])
    .filter((t) => (view === "running" ? !TERMINAL.includes(t.status) : TERMINAL.includes(t.status)))
    .filter((t) => !onlyThisPair || !symbol || t.symbol === symbol);

  const runningCount = (rows ?? []).filter((t) => !TERMINAL.includes(t.status)).length;

  return (
    <div className="oui-flex oui-flex-col oui-text-xs">
      {/* Strategy row. TWAP is the only one today; the row is what lets another
          sit beside it without moving anything. */}
      <div className="oui-flex oui-items-center oui-gap-2 oui-border-b oui-border-base-6 oui-px-3 oui-py-2">
        <span className="oui-rounded oui-bg-base-5 oui-px-2 oui-py-1">TWAP</span>
      </div>

      {/* Running / History, and how fresh the numbers are. */}
      <div className="oui-flex oui-flex-wrap oui-items-center oui-gap-3 oui-px-3 oui-py-2">
        {(["running", "history"] as const).map((v) => (
          <button
            key={v}
            className={`oui-rounded oui-px-2 oui-py-1 ${
              view === v ? "oui-bg-base-5 oui-text-base-contrast" : "oui-text-base-contrast-54"
            }`}
            onClick={() => setView(v)}
          >
            {v === "running" ? `Running${runningCount ? ` (${runningCount})` : ""}` : "History"}
          </button>
        ))}
        <span className="oui-ml-auto oui-flex oui-items-center oui-gap-3 oui-text-base-contrast-36">
          {rows && <span>Data refreshes in {countdown}s</span>}
          {symbol && (
            <label className="oui-flex oui-items-center oui-gap-1">
              <input
                type="checkbox"
                checked={onlyThisPair}
                onChange={(e) => setOnlyThisPair(e.target.checked)}
              />
              Hide other pairs
            </label>
          )}
        </span>
      </div>

      {needsSignIn ? (
        <div className="oui-flex oui-flex-col oui-items-center oui-gap-2 oui-px-3 oui-py-8">
          <span className="oui-text-base-contrast-36">
            Sign in to see the orders on your account.
          </span>
          <button className="oui-rounded oui-bg-primary oui-px-3 oui-py-1.5" onClick={signIn}>
            Sign in
          </button>
        </div>
      ) : error && !rows ? (
        <Empty>Could not load your orders — {error}</Empty>
      ) : !rows ? (
        <Empty>Loading…</Empty>
      ) : !visible.length ? (
        <Empty>
          {view === "running" ? "No running bot orders." : "No finished bot orders yet."}
        </Empty>
      ) : (
        <div className="oui-w-full oui-overflow-x-auto">
          <table className="oui-w-full">
            <thead className="oui-text-base-contrast-36">
              <tr className="oui-border-b oui-border-base-6">
                <Th>Ticket ID</Th>
                {view === "history" && <Th>End time</Th>}
                <Th>Pair</Th>
                <Th>Direction</Th>
                <Th>Filled</Th>
                <Th>Filled / Total amount</Th>
                <Th>Initiated time</Th>
                {view === "history" ? <Th>Status</Th> : <Th>Actions</Th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => {
                const { total, done, pct } = progressOf(t);
                return (
                  <tr key={t.ticket_id} className="oui-border-b oui-border-base-6">
                    <Td>
                      <TicketId id={t.ticket_id} />
                    </Td>
                    {view === "history" && <Td muted>{stamp(t.last_update_time_ms)}</Td>}
                    <Td>{pair(t.symbol)}</Td>
                    <Td>
                      <Direction t={t} />
                    </Td>
                    <Td>
                      <Filled pct={pct} />
                    </Td>
                    <Td>
                      <span className="oui-tabular-nums">
                        {qty(done)} / {qty(total)}
                      </span>{" "}
                      <span className="oui-text-base-contrast-36">{baseAsset(t.symbol)}</span>
                    </Td>
                    <Td muted>{stamp(t.start_time_ms)}</Td>
                    {view === "history" ? (
                      <Td>
                        <span
                          className={
                            t.status === "COMPLETE" ? "" : "oui-text-warning"
                          }
                        >
                          {STATUS_LABEL[t.status] ?? t.status}
                        </span>
                        {t.cancel_reason && (
                          <span className="oui-text-base-contrast-36">
                            {" "}
                            · {CANCEL_REASON_LABEL[t.cancel_reason] ?? t.cancel_reason}
                          </span>
                        )}
                      </Td>
                    ) : (
                      <Td>
                        {/* A TWAP runs for minutes, so it has to be stoppable.
                            Ending it keeps whatever has already filled. */}
                        <button
                          className="oui-text-warning hover:oui-underline"
                          onClick={() => end(t.ticket_id)}
                        >
                          End
                        </button>
                        {/* Past its window but still working: the engine keeps
                            a ticket running after expiry, so say so rather than
                            implying it stopped. */}
                        {t.is_expired && (
                          <span className="oui-ml-2 oui-text-base-contrast-36">past window</span>
                        )}
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {error && rows && (
        <div className="oui-px-3 oui-py-2 oui-text-danger">{error}</div>
      )}
    </div>
  );
}

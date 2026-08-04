/**
 * Blockfill TWAP order form — rendered in place of the host's order-entry body
 * when the trader picks our TWAP order type.
 *
 * It follows the host's own layout (side, available, size, then the order's own
 * settings) so TWAP reads as one of the exchange's order types rather than a
 * bolted-on panel. Quantity is written through the host's order store, and the
 * asset info below (est. liq. price, fees) is the host's own — we do not
 * duplicate it.
 *
 * This IS a real React component (hooks allowed), rendered by the interceptor.
 */
import * as React from "react";
import {
  usePositionStream,
  useCollateral,
  useAccount,
  useConfig,
  useWalletConnector,
  useOrderStore,
  useSymbolInfo,
  useMarkPriceBySymbol,
} from "@orderly.network/hooks";
import { AccountStatusEnum } from "@orderly.network/types";

import {
  placeTicket,
  getSession,
  isOnboarded,
  onboard,
  queryTicket,
  queryOpenTicket,
  peekSession,
  type Session,
  type Strategy,
  type TicketProgress,
} from "./api.js";

/** Duration presets → time_constraint in ms. */
const TIMEOUT_PRESETS: Array<{ label: string; ms: number }> = [
  { label: "5m", ms: 5 * 60_000 },
  { label: "30m", ms: 30 * 60_000 },
  { label: "1h", ms: 60 * 60_000 },
  { label: "6h", ms: 6 * 60 * 60_000 },
];

/**
 * Format a size for display at the market's own precision.
 *
 * Sizes are accumulated by repeated addition, so they carry binary
 * floating-point noise (0.0051 arrives as 0.005099999999999993). `dp` is the
 * instrument's `base_dp`, so we show exactly the precision it trades in rather
 * than an arbitrary cutoff. Trailing zeros are dropped.
 */
function formatQty(value: number, dp: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(dp)));
}

/** "PERP_ETH_USDC" → { base: "ETH", quote: "USDC" }. */
function splitSymbol(sym?: string): { base: string; quote: string } {
  const parts = (sym ?? "PERP_ETH_USDC").split("_");
  return { base: parts[1] ?? "ETH", quote: parts[2] ?? "USDC" };
}

export function BlockfillOrderPanel({ symbol, api }: { symbol?: string; api?: any }) {
  const { base, quote } = splitSymbol(symbol);

  const [timeoutMs, setTimeoutMs] = React.useState<number>(TIMEOUT_PRESETS[1].ms);
  const [strategy, setStrategy] = React.useState<Strategy>("MAKER");
  const [status, setStatus] = React.useState<string>("");
  const [tracked, setTracked] = React.useState<{ id: string; session?: Session } | null>(null);
  const [progress, setProgress] = React.useState<TicketProgress | null>(null);

  // Buy/Sell is owned here rather than read back from the host's switch: the
  // submit button states the direction, and it must never be able to disagree
  // with what we send. The host's own switch is hidden for this order type.
  const [side, setSide] = React.useState<"BUY" | "SELL">("BUY");

  // Quantity is written into the host's order store so its slider, max-qty and
  // validation stay in sync with what is typed here.
  const entry = useOrderStore((s: any) => s.entry);
  const actions = useOrderStore((s: any) => s.actions);
  const qty: string = entry?.order_quantity ?? "";

  // Orderly-native symbol for this market (e.g. "PERP_ETH_USDC").
  const orderlySymbol = symbol ?? `PERP_${base}_${quote}`;

  // Display precision for this market: the exchange's own base decimal places
  // (base_tick 0.0001 -> 4 dp for ETH), so sizes are not shown to a made-up
  // precision the instrument does not trade in.
  const symbolInfo = useSymbolInfo(orderlySymbol);
  const baseDp: number = (symbolInfo?.("base_dp", 4) as number | undefined) ?? 4;

  // Order size can be entered either as a quantity or as notional; the mark
  // price converts between them and the quantity remains the single source of
  // truth (it is what the host's store and our ticket both use).
  const markPrice = useMarkPriceBySymbol(orderlySymbol);
  const setQuantity = (value: string) =>
    actions?.updateOrderByKey?.("order_quantity", value);
  const notional =
    Number(qty) > 0 && markPrice > 0 ? String(Number((Number(qty) * markPrice).toFixed(2))) : "";
  const setNotional = (value: string) => {
    const usd = Number(value);
    if (!value) return setQuantity("");
    if (!Number.isFinite(usd) || markPrice <= 0) return;
    setQuantity(String(Number((usd / markPrice).toFixed(baseDp))));
  };

  // Timeout is entered as hours + minutes; the ticket carries milliseconds.
  const hours = String(Math.floor(timeoutMs / 3_600_000) || 0);
  const minutes = String(Math.floor((timeoutMs % 3_600_000) / 60_000) || 0);
  const setDuration = (h: string, m: string) => {
    const ms = (Number(h) || 0) * 3_600_000 + (Number(m) || 0) * 60_000;
    setTimeoutMs(ms);
  };

  // Live account state from the Orderly SDK (the panel is rendered inside
  // OrderlyAppProvider, so these stream hooks are in-context).
  //  - current signed position for this symbol → target_position is computed as
  //    an ABSOLUTE target off the real starting position, not a flat assumption.
  //  - free collateral → the "Available" figure shown under Buy/Sell.
  const [positionInfo] = usePositionStream(orderlySymbol);
  const currentPosition =
    positionInfo?.rows?.find((r) => r.symbol === orderlySymbol)?.position_qty ?? 0;
  const { freeCollateral } = useCollateral();
  const available = freeCollateral ?? 0;

  // Authenticated trader identity from the Orderly SDK session. The wallet
  // ADDRESS drives our own session auth (challenge → sign → Bearer token); the
  // order then executes on THIS trader's account, not a hardcoded one.
  const { state } = useAccount();
  const brokerId = useConfig<string>("brokerId");
  const address = state?.address;

  // Sign through the wallet the trader actually connected (MetaMask,
  // WalletConnect, Binance, …) rather than a hardcoded injected provider, so
  // every wallet the host DEX supports works with this plugin.
  const { wallet, connectedChain } = useWalletConnector();
  const walletProvider = wallet?.provider as
    | { request(args: { method: string; params?: unknown[] }): Promise<any> }
    | undefined;
  const chainId = connectedChain?.id ? Number(connectedChain.id) : undefined;

  // Only allow submitting once the trader has completed Orderly's own login
  // ("Enable Trading"). Before that there is no account context: balances and
  // positions read 0, so a ticket would target a position we cannot see.
  const isTradingEnabled = state?.status === AccountStatusEnum.EnableTrading;

  // A TWAP keeps running server-side after the tab is closed, so on mount pick
  // up any ticket already in flight for this market. Without this, reloading
  // mid-execution made a live order look like it had vanished.
  //
  // Only an already-cached session is used (`peekSession`): looking at progress
  // must never pop a signature request.
  React.useEffect(() => {
    if (tracked || progress) return;
    let cancelled = false;
    (async () => {
      const session =
        address && brokerId ? peekSession(brokerId, address) : undefined;
      const open = await queryOpenTicket(orderlySymbol, session).catch(() => null);
      if (cancelled || !open) return;
      setProgress(open);
      setTracked({ id: open.ticket_id, session });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderlySymbol, address, brokerId]);

  // Follow the ticket after it is placed: a TWAP fills over minutes, so without
  // this the panel would go quiet and the trader could not tell whether their
  // order was working or finished.
  React.useEffect(() => {
    if (!tracked) return;
    let cancelled = false;
    const poll = async () => {
      const p = await queryTicket(tracked.id, tracked.session).catch(() => null);
      if (cancelled || !p) return;
      setProgress(p);
      if (["COMPLETE", "CANCEL", "EXPIRED"].includes(p.status) || p.is_expired) setTracked(null);
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tracked]);

  async function onSubmit() {
    if (!isTradingEnabled) {
      setStatus("Connect your wallet and enable trading first");
      return;
    }
    const size = Number(qty);
    if (!Number.isFinite(size) || size <= 0) {
      setStatus("Enter a quantity in the order form above");
      return;
    }
    // Ticket target is ABSOLUTE (executor computes the delta to trade).
    const target_position = currentPosition + (side === "BUY" ? size : -size);
    const ticket = {
      exchange: "orderly" as const,
      // Orderly-native symbol (e.g. "PERP_ETH_USDC") — matches the server's
      // instrument cache (GET /v1/public/info) and the executor's parser.
      symbol: orderlySymbol,
      target_position,
      time_constraint_ms: timeoutMs,
      strategy, // MAKER / TAKER hint for the execution engine
    };
    try {
      // Real auth: establish a wallet-signature session (one signature prompt),
      // so the order executes on THIS connected trader's account. If no wallet
      // address is available (local/demo harness), fall back to the static key.
      let session;
      if (address && brokerId && walletProvider) {
        if (!chainId) throw new Error("wallet chain unavailable");
        setStatus("Sign in your wallet to authorize…");
        session = await getSession(brokerId, address, chainId, walletProvider);
        // First time on this DEX: delegate a trading key so the executor can
        // trade this account (one extra signature; hot-onboards within ~60s).
        if (!(await isOnboarded(session))) {
          setStatus("Enabling smart execution — sign to delegate…");
          await onboard(session, brokerId, address, chainId, walletProvider);
        }
      }
      setStatus("Placing…");
      const res = await placeTicket(ticket, session);
      setStatus("");
      setProgress(null);
      setTracked({ id: res.ticket_id, session });
    } catch (e: any) {
      setStatus(`Failed: ${e?.message ?? e}`);
    }
  }

  const btn = (active: boolean) =>
    `oui-px-2 oui-py-1 oui-rounded oui-text-sm ${active ? "oui-bg-primary oui-text-white" : "oui-bg-base-6"}`;

  return (
    <div className="oui-flex oui-flex-col oui-gap-2 oui-p-2 oui-rounded-lg oui-bg-base-8">
      {/* Buy / Sell — owned here so the submit button cannot state a direction
          different from the one we send. */}
      <div className="oui-grid oui-grid-cols-2 oui-gap-2">
        <button
          className={`oui-py-1 oui-rounded oui-text-sm ${
            side === "BUY" ? "oui-bg-success oui-text-white" : "oui-bg-base-6"
          }`}
          onClick={() => setSide("BUY")}
        >
          Buy
        </button>
        <button
          className={`oui-py-1 oui-rounded oui-text-sm ${
            side === "SELL" ? "oui-bg-danger oui-text-white" : "oui-bg-base-6"
          }`}
          onClick={() => setSide("SELL")}
        >
          Sell
        </button>
      </div>

      <div className="oui-flex oui-justify-between oui-text-xs oui-text-base-contrast-54">
        <span>Available</span>
        <span>
          {available.toFixed(2)} {quote}
        </span>
      </div>

      {/* Quantity in base units and the same order expressed as notional. Both
          edit the one order size — traders size either way round. */}
      <div className="oui-grid oui-grid-cols-2 oui-gap-2">
        <label className="oui-flex oui-flex-col oui-text-xs oui-gap-1">
          Qty
          <div className="oui-flex oui-items-center oui-gap-1 oui-border oui-rounded oui-px-2 oui-py-1">
            <input
              className="oui-w-full oui-min-w-0 oui-flex-1 oui-bg-transparent oui-outline-none"
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="0"
            />
            <span className="oui-text-base-contrast-54">{base}</span>
          </div>
        </label>
        <label className="oui-flex oui-flex-col oui-text-xs oui-gap-1">
          Order size
          <div className="oui-flex oui-items-center oui-gap-1 oui-border oui-rounded oui-px-2 oui-py-1">
            <input
              className="oui-w-full oui-min-w-0 oui-flex-1 oui-bg-transparent oui-outline-none"
              inputMode="decimal"
              value={notional}
              onChange={(e) => setNotional(e.target.value)}
              placeholder="0"
            />
            <span className="oui-text-base-contrast-54">{quote}</span>
          </div>
        </label>
      </div>

      {/* Execution window: an exact hours/minutes entry plus the common presets. */}
      <div className="oui-flex oui-flex-col oui-gap-1">
        <span className="oui-text-xs">Timeout</span>
        <div className="oui-grid oui-grid-cols-2 oui-gap-2">
          <div className="oui-flex oui-items-center oui-gap-1 oui-border oui-rounded oui-px-2 oui-py-1">
            <input
              className="oui-w-full oui-min-w-0 oui-flex-1 oui-bg-transparent oui-outline-none oui-text-xs"
              inputMode="numeric"
              value={hours}
              onChange={(e) => setDuration(e.target.value, minutes)}
              placeholder="0"
            />
            <span className="oui-text-xs oui-text-base-contrast-54">hr</span>
          </div>
          <div className="oui-flex oui-items-center oui-gap-1 oui-border oui-rounded oui-px-2 oui-py-1">
            <input
              className="oui-w-full oui-min-w-0 oui-flex-1 oui-bg-transparent oui-outline-none oui-text-xs"
              inputMode="numeric"
              value={minutes}
              onChange={(e) => setDuration(hours, e.target.value)}
              placeholder="0"
            />
            <span className="oui-text-xs oui-text-base-contrast-54">min</span>
          </div>
        </div>
        <div className="oui-grid oui-grid-cols-4 oui-gap-2">
          {TIMEOUT_PRESETS.map((p) => (
            <button key={p.label} className={btn(timeoutMs === p.ms)} onClick={() => setTimeoutMs(p.ms)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Strategy: Maker / Taker */}
      <div className="oui-flex oui-flex-col oui-gap-1">
        <span className="oui-text-xs">Strategy</span>
        <div className="oui-grid oui-grid-cols-2 oui-gap-2">
          <button className={btn(strategy === "MAKER")} onClick={() => setStrategy("MAKER")}>Maker</button>
          <button className={btn(strategy === "TAKER")} onClick={() => setStrategy("TAKER")}>Taker</button>
        </div>
      </div>

      {/* Where this order leaves the position. The engine works to an absolute
          target, so state it before the trader commits. */}
      {Number(qty) > 0 && (
        <div className="oui-flex oui-justify-between oui-text-xs oui-text-base-contrast-54">
          <span>Position</span>
          <span>
            {formatQty(currentPosition, baseDp)} →{" "}
            {formatQty(currentPosition + (side === "BUY" ? Number(qty) : -Number(qty)), baseDp)} {base}
          </span>
        </div>
      )}

      <button
        className={`oui-mt-1 oui-py-2 oui-rounded oui-text-white ${
          !isTradingEnabled
            ? "oui-bg-base-6 oui-cursor-not-allowed"
            : side === "BUY"
              ? "oui-bg-success"
              : "oui-bg-danger"
        }`}
        onClick={onSubmit}
        disabled={!isTradingEnabled}
      >
        {isTradingEnabled
          ? `${side === "BUY" ? "Buy / Long" : "Sell / Short"} ${base}`
          : "Connect wallet to trade"}
      </button>

      {status && <div className="oui-text-xs oui-text-base-contrast-54">{status}</div>}

      {/* Live execution progress for the ticket we just placed. */}
      {progress && (
        <div className="oui-flex oui-flex-col oui-gap-1 oui-rounded oui-bg-base-7 oui-p-2 oui-text-xs">
          <div className="oui-flex oui-justify-between">
            <span className="oui-text-base-contrast-54">
              {progress.ticket_id.slice(0, 12)}…
            </span>
            <span>{progress.status}</span>
          </div>
          {(() => {
            const total = Math.abs(progress.target_position - progress.init_position);
            const done = Math.abs(progress.executed_position);
            const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
            return (
              <>
                <div className="oui-h-1 oui-w-full oui-rounded oui-bg-base-5">
                  <div
                    className="oui-h-1 oui-rounded oui-bg-primary"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="oui-text-base-contrast-54">
                  Filled {formatQty(done, baseDp)} / {formatQty(total, baseDp)} {base} ({pct.toFixed(1)}%)
                </div>
                {/* A ticket targets an absolute position, so show where it is
                    heading — "sell 0.05" of a 0.5 position is not the same as
                    a target of 0.05, and only the target says which it is. */}
                <div className="oui-text-base-contrast-36">
                  {formatQty(progress.init_position, baseDp)} → {formatQty(progress.target_position, baseDp)} {base}
                </div>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

/**
 * Blockfill TWAP controls — rendered in the host's submit slot when the trader
 * picks our TWAP order type.
 *
 * Side and quantity are NOT duplicated here: they are read from the host's own
 * order form (`useOrderStore`), so the trader fills one form and this only adds
 * what TWAP needs — a duration, a maker/taker preference, and the submit that
 * routes to the blockfill execution engine.
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
} from "@orderly.network/hooks";
import { AccountStatusEnum } from "@orderly.network/types";

import { placeTicket, getSession, isOnboarded, onboard, type Strategy } from "./api.js";

/** Duration presets → time_constraint in ms. */
const TIMEOUT_PRESETS: Array<{ label: string; ms: number }> = [
  { label: "5m", ms: 5 * 60_000 },
  { label: "30m", ms: 30 * 60_000 },
  { label: "1h", ms: 60 * 60_000 },
  { label: "6h", ms: 6 * 60 * 60_000 },
];

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

  // The host's live order form. Side still comes from its Buy/Sell switch, and
  // the quantity is written back into the same store, so the host's slider and
  // validation stay in sync with what is typed here.
  const entry = useOrderStore((s: any) => s.entry);
  const actions = useOrderStore((s: any) => s.actions);
  const side: "BUY" | "SELL" = entry?.side === "SELL" ? "SELL" : "BUY";
  const qty: string = entry?.order_quantity ?? "";

  // Orderly-native symbol for this market (e.g. "PERP_ETH_USDC").
  const orderlySymbol = symbol ?? `PERP_${base}_${quote}`;

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
      setStatus(`Ticket placed: ${res.ticket_id}`);
    } catch (e: any) {
      setStatus(`Failed: ${e?.message ?? e}`);
    }
  }

  const btn = (active: boolean) =>
    `oui-px-2 oui-py-1 oui-rounded oui-text-sm ${active ? "oui-bg-primary oui-text-white" : "oui-bg-base-6"}`;

  return (
    <div className="oui-flex oui-flex-col oui-gap-2 oui-p-2 oui-rounded-lg oui-bg-base-8">
      <div className="oui-text-xs oui-text-base-contrast-54">
        Available: {available.toFixed(2)} {quote}
      </div>

      {/* Quantity. TWAP has no price, so this is the only order input we need;
          Buy/Sell still comes from the host's own switch above. */}
      <label className="oui-flex oui-flex-col oui-text-xs oui-gap-1">
        Quantity
        <div className="oui-flex oui-items-center oui-gap-1 oui-border oui-rounded oui-px-2 oui-py-1">
          <input
            className="oui-flex-1 oui-bg-transparent oui-outline-none"
            inputMode="decimal"
            value={qty}
            onChange={(e) => actions?.updateOrderByKey?.("order_quantity", e.target.value)}
            placeholder="0"
          />
          <span className="oui-text-base-contrast-54">{base}</span>
        </div>
      </label>

      {/* Execution window */}
      <div className="oui-flex oui-flex-col oui-gap-1">
        <span className="oui-text-xs">Duration</span>
        <div className="oui-flex oui-gap-2">
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
        <div className="oui-flex oui-gap-2">
          <button className={btn(strategy === "MAKER")} onClick={() => setStrategy("MAKER")}>Maker</button>
          <button className={btn(strategy === "TAKER")} onClick={() => setStrategy("TAKER")}>Taker</button>
        </div>
      </div>

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
          ? `${side === "BUY" ? "Buy" : "Sell"} ${base} · TWAP`
          : "Connect wallet to trade"}
      </button>

      {status && <div className="oui-text-xs oui-text-base-contrast-54">{status}</div>}
    </div>
  );
}

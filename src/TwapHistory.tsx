/**
 * TWAP order history — the content of the tab we add to the host's data list.
 *
 * The host's own tabs (Pending, Filled, Order history …) only know about
 * exchange orders, so a TWAP ticket appears there as the individual child fills
 * with nothing tying them together. This lists the tickets themselves, so a
 * trader can see what they asked for, how much of it filled, and stop one that
 * is still working.
 */
import * as React from "react";
import { useAccount, useConfig } from "@orderly.network/hooks";

import { cancelTicket, peekSession, queryTickets, type TicketProgress } from "./api.js";

const TERMINAL = ["COMPLETE", "CANCEL", "EXPIRED"];

function fmt(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(6)));
}

function time(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(
    d.getHours(),
  ).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function TwapHistory() {
  const [rows, setRows] = React.useState<TicketProgress[]>([]);
  const [error, setError] = React.useState<string>("");
  const { state } = useAccount();
  const brokerId = useConfig<string>("brokerId");
  const address = state?.address;

  // Read-only: use a cached session if there is one, never prompt to sign just
  // to look at history.
  const session = address && brokerId ? peekSession(brokerId, address) : undefined;

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const list = await queryTickets(session).catch(() => []);
      if (!cancelled) setRows(list);
    };
    load();
    // Working tickets change while the tab is open.
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, brokerId]);

  if (!rows.length) {
    return (
      <div className="oui-p-4 oui-text-xs oui-text-base-contrast-36">
        No TWAP orders yet.
      </div>
    );
  }

  return (
    <div className="oui-w-full oui-overflow-x-auto">
      <table className="oui-w-full oui-text-xs">
        <thead className="oui-text-base-contrast-36">
          <tr>
            {["Time", "Symbol", "Side", "Filled / Total", "Position", "Status", ""].map((h) => (
              <th key={h} className="oui-px-3 oui-py-2 oui-text-left oui-font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const total = Math.abs(t.target_position - t.init_position);
            const done = Math.abs(t.executed_position);
            const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
            const isBuy = t.target_position >= t.init_position;
            const working = !TERMINAL.includes(t.status);
            return (
              <tr key={t.ticket_id} className="oui-border-t oui-border-base-6">
                <td className="oui-px-3 oui-py-2 oui-text-base-contrast-54">
                  {time(t.start_time_ms)}
                </td>
                <td className="oui-px-3 oui-py-2">{t.symbol}</td>
                <td
                  className={`oui-px-3 oui-py-2 ${isBuy ? "oui-text-success" : "oui-text-danger"}`}
                >
                  {isBuy ? "Buy" : "Sell"}
                </td>
                <td className="oui-px-3 oui-py-2">
                  {fmt(done)} / {fmt(total)}{" "}
                  <span className="oui-text-base-contrast-36">({pct.toFixed(1)}%)</span>
                </td>
                <td className="oui-px-3 oui-py-2 oui-text-base-contrast-54">
                  {fmt(t.init_position)} → {fmt(t.target_position)}
                </td>
                <td className="oui-px-3 oui-py-2">
                  {t.status}
                  {t.is_expired && working ? (
                    <span className="oui-text-base-contrast-36"> · past window</span>
                  ) : null}
                </td>
                <td className="oui-px-3 oui-py-2">
                  {working && (
                    <button
                      className="oui-rounded oui-bg-base-5 oui-px-2 oui-py-0.5"
                      onClick={async () => {
                        setError("");
                        try {
                          await cancelTicket(t.ticket_id, session);
                        } catch (e: any) {
                          setError(`Cancel failed: ${e?.message ?? e}`);
                        }
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && <div className="oui-px-3 oui-py-2 oui-text-xs oui-text-danger">{error}</div>}
    </div>
  );
}

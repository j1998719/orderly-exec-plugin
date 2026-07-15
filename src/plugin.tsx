/**
 * Blockfill execution module — Orderly Network marketplace plugin.
 *
 * A DEX installs this plugin into its `OrderlyAppProvider`:
 *
 *   import { registerBlockfillExec } from "@blockfill/orderly-exec-plugin";
 *   <OrderlyAppProvider plugins={[registerBlockfillExec()]} ... />
 *
 * It injects a custom TWAP/Maker order-entry panel at the order-entry submit slot;
 * the panel routes orders to the blockfill execution engine via blockfill-server's
 * `/execution/v1/tickets/placeTicket` (see ./api).
 *
 * NOTE: the interceptor `component(Original, props, api)` is NOT itself a React
 * component — do not call hooks in it. It renders a child (`<BlockfillOrderPanel>`)
 * that owns all hook usage.
 */
import * as React from "react";

import { BlockfillOrderPanel } from "./OrderForm";

/** Runtime injector target for the order-entry submit area. */
const ORDER_ENTRY_TARGET = "Trading.OrderEntry.SubmitSection";

/**
 * Returns the plugin descriptor consumed by `OrderlyAppProvider`'s `plugins` prop.
 * `id` must equal `pluginId` in `.orderly-manifest.json`.
 */
export function registerBlockfillExec() {
  return {
    name: "Blockfill Execution",
    id: "blockfill-exec",
    interceptors: [
      {
        target: ORDER_ENTRY_TARGET,
        // `api` exposes plugin utilities (config, current symbol, etc.) — passed through.
        component: (Original: React.ComponentType<any>, props: any, api: any) => (
          <div className="oui-flex oui-flex-col oui-gap-2">
            <BlockfillOrderPanel symbol={props?.symbol ?? api?.symbol} api={api} />
            {/* Keep the host's native order entry available beneath our panel. */}
            <Original {...props} />
          </div>
        ),
      },
    ],
  };
}

export default registerBlockfillExec;

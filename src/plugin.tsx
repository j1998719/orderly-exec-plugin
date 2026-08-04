/**
 * Blockfill execution module — Orderly Network marketplace plugin.
 *
 * A DEX installs this plugin into its `OrderlyAppProvider`:
 *
 *   import { registerBlockfillExec } from "@j1998719/orderly-exec-plugin";
 *   <OrderlyAppProvider plugins={[registerBlockfillExec()]} ... />
 *
 * It adds TWAP as an order type alongside the host's native ones. The SDK's
 * order types are a fixed enum with no registration API, so we add the tab at
 * the order-type slot and swap the submit section when it is selected; the rest
 * of the order form (side, quantity) stays native, and our submit reads it.
 *
 * NOTE: the interceptor `component(Original, props, api)` is NOT itself a React
 * component — do not call hooks in it. It renders a child that owns hook usage.
 */
import * as React from "react";
import type { OrderlyPlugin } from "@orderly.network/plugin-core";

import { BlockfillOrderPanel } from "./OrderForm.js";
import { setTwapSelected, useTwapSelected } from "./mode.js";

/** Runtime injector targets. */
const ORDER_TYPE_TABS_TARGET = "Trading.OrderEntry.TypeTabs";
const SUBMIT_SECTION_TARGET = "Trading.OrderEntry.SubmitSection";

/**
 * The native order-type tabs with a TWAP tab appended. Clicking anywhere in the
 * native tabs deselects TWAP, so the two stay mutually exclusive even though the
 * SDK does not know our tab exists.
 */
function OrderTypeTabs({
  Original,
  props,
}: {
  Original: React.ComponentType<any>;
  props: any;
}) {
  const twap = useTwapSelected();
  return (
    <div className="oui-flex oui-items-center oui-gap-2">
      <div className="oui-contents" onClickCapture={() => setTwapSelected(false)}>
        <Original {...props} />
      </div>
      <button
        type="button"
        onClick={() => setTwapSelected(true)}
        className={`oui-px-2 oui-py-1 oui-text-sm oui-rounded ${
          twap ? "oui-text-base-contrast" : "oui-text-base-contrast-36"
        }`}
      >
        TWAP
      </button>
    </div>
  );
}

/**
 * The submit area: our TWAP controls when TWAP is selected, otherwise the host's
 * own submit untouched — so the trader never sees two competing order forms.
 */
function SubmitSection({
  Original,
  props,
  api,
}: {
  Original: React.ComponentType<any>;
  props: any;
  api: any;
}) {
  const twap = useTwapSelected();
  if (!twap) return <Original {...props} />;
  return <BlockfillOrderPanel symbol={props?.symbol ?? api?.symbol} api={api} />;
}

/**
 * Returns the plugin descriptor consumed by `OrderlyAppProvider`'s `plugins` prop.
 * `id` must equal `pluginId` in `.orderly-manifest.json`.
 */
export function registerBlockfillExec(): OrderlyPlugin {
  return {
    name: "Blockfill Execution",
    id: "blockfill-exec",
    interceptors: [
      {
        target: ORDER_TYPE_TABS_TARGET,
        component: (Original: React.ComponentType<any>, props: any) => (
          <OrderTypeTabs Original={Original} props={props} />
        ),
      },
      {
        target: SUBMIT_SECTION_TARGET,
        component: (Original: React.ComponentType<any>, props: any, api: any) => (
          <SubmitSection Original={Original} props={props} api={api} />
        ),
      },
    ],
  };
}

export default registerBlockfillExec;

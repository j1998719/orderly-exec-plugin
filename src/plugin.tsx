/**
 * Blockfill execution module — Orderly Network marketplace plugin.
 *
 * A DEX installs this plugin into its `OrderlyAppProvider`:
 *
 *   import { registerBlockfillExec } from "@j1998719/orderly-exec-plugin";
 *   <OrderlyAppProvider plugins={[registerBlockfillExec()]} ... />
 *
 * TWAP is offered as a custom order type through the SDK's own extension points:
 * the order-type dropdowns accept a non-built-in id, and the host then reports it
 * back as `selectedCustomTypeId`. So TWAP appears in the Advanced list next to
 * Stop Limit / Scaled / …, and selecting it swaps the order form body and submit
 * for ours — the trader never sees two competing order forms.
 *
 * NOTE: the interceptor `component(Original, props, api)` is NOT itself a React
 * component — do not call hooks in it. It renders a child that owns hook usage.
 */
import * as React from "react";
import type { OrderlyPlugin } from "@orderly.network/plugin-core";

import { BlockfillOrderPanel } from "./OrderForm.js";
import { TwapHistory } from "./TwapHistory.js";
import { TWAP_TYPE_ID } from "./mode.js";

/** Runtime injector targets (see @orderly.network/ui-order-entry). */
const ADVANCED_SELECT_TARGET = "Trading.OrderEntry.AdvancedSelect";
const MOBILE_TYPE_SELECT_TARGET = "Trading.OrderEntry.MobileTypeSelect";
const BODY_TARGET = "Trading.OrderEntry.Body";
const BUY_SELL_SWITCH_TARGET = "Trading.OrderEntry.BuySellSwitch";
const DATA_LIST_DESKTOP_TABS = "Trading.DataList.Desktop.Tabs";
const DATA_LIST_MOBILE_TABS = "Trading.DataList.Mobile.Tabs";

const TWAP_OPTION = { value: TWAP_TYPE_ID, label: "TWAP" };

/**
 * Add TWAP to an order-type dropdown. The host routes a non-built-in value to
 * `onExtraSelect`, so we only have to contribute the option and mirror the
 * choice locally for the slots the host does not hand it to.
 */
function withTwapOption(Original: React.ComponentType<any>, props: any) {
  const items = Array.isArray(props?.items) ? props.items : [];
  if (items.some((i: any) => i?.value === TWAP_TYPE_ID)) {
    return <Original {...props} />;
  }
  return (
    <Original
      {...props}
      items={[...items, TWAP_OPTION]}
      onValueChange={(value: string) => props?.onValueChange?.(value)}
    />
  );
}

/**
 * Append a TWAP tab to the host's data list. Its own tabs only know about
 * exchange orders, so a ticket would otherwise be visible only as scattered
 * child fills with nothing showing the order that produced them.
 */
function withTwapTab(Original: React.ComponentType<any>, props: any) {
  const items = Array.isArray(props?.items) ? props.items : [];
  if (items.some((i: any) => i?.id === TWAP_TYPE_ID)) return <Original {...props} />;
  return (
    <Original
      {...props}
      items={[...items, { id: TWAP_TYPE_ID, title: "TWAP", content: <TwapHistory /> }]}
    />
  );
}

/**
 * The order form body: the whole TWAP form while our type is selected, the
 * host's own body otherwise.
 *
 * Everything TWAP needs lives here — quantity, duration, maker/taker and the
 * submit — because the host does not render its submit section for a custom
 * order type, so a plugin's body has to be self-contained.
 */
function OrderEntryBody({
  Original,
  props,
  api,
}: {
  Original: React.ComponentType<any>;
  props: any;
  api: any;
}) {
  if ((props?.selectedCustomTypeId ?? null) !== TWAP_TYPE_ID) {
    return <Original {...props} />;
  }
  return <BlockfillOrderPanel symbol={props?.symbol} api={api} />;
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
        target: ADVANCED_SELECT_TARGET,
        component: (Original: React.ComponentType<any>, props: any) =>
          withTwapOption(Original, props),
      },
      {
        target: MOBILE_TYPE_SELECT_TARGET,
        component: (Original: React.ComponentType<any>, props: any) =>
          withTwapOption(Original, props),
      },
      {
        // Our body carries its own Buy/Sell, so hide the host's for this type
        // rather than leaving two side controls that can disagree.
        target: BUY_SELL_SWITCH_TARGET,
        component: (Original: React.ComponentType<any>, props: any) =>
          (props?.selectedCustomTypeId ?? null) === TWAP_TYPE_ID ? null : (
            <Original {...props} />
          ),
      },
      {
        target: DATA_LIST_DESKTOP_TABS,
        component: (Original: React.ComponentType<any>, props: any) =>
          withTwapTab(Original, props),
      },
      {
        target: DATA_LIST_MOBILE_TABS,
        component: (Original: React.ComponentType<any>, props: any) =>
          withTwapTab(Original, props),
      },
      {
        target: BODY_TARGET,
        component: (Original: React.ComponentType<any>, props: any, api: any) => (
          <OrderEntryBody Original={Original} props={props} api={api} />
        ),
      },
    ],
  };
}

export default registerBlockfillExec;

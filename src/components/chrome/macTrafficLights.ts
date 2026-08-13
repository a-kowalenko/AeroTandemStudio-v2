/**
 * macOS Overlay titlebar: keep traffic-light top edge aligned with logo top edge.
 *
 * Logo sits in AppChrome with `py-[5px]` — trafficLightPosition.y must match.
 * Must stay in sync with `src-tauri/tauri.conf.json` → windows[0].trafficLightPosition.
 */
export const MAC_TRAFFIC_LIGHT_POSITION = { x: 14, y: 5 } as const;

/** Left padding so brand/content clears the traffic-light cluster. */
export const MAC_TRAFFIC_LIGHT_INSET_CLASS = "pl-[76px]";

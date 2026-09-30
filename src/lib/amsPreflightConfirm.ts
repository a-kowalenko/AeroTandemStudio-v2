/** Soft confirm when AMS create-preflight reports customer/booking not found. */
export type AmsPreflightConfirmState = {
  open: true;
};

export const AMS_PREFLIGHT_NOT_FOUND_PREFIX = "AMS_PREFLIGHT_NOT_FOUND";

export function isAmsPreflightNotFoundError(raw: string): boolean {
  return raw.toUpperCase().includes(AMS_PREFLIGHT_NOT_FOUND_PREFIX);
}

/** Default SD backup / AMS hostname label: `Max (Buero-PC)` or host-only. */

export function composeSdPcName(
  computerName: string,
  operatorName: string,
): string {
  const host = computerName.trim();
  const op = operatorName.trim();
  if (op && host) return `${op} (${host})`;
  if (host) return host;
  return op;
}

/** True when the value is empty or still the system-generated default. */
export function isAutoSdPcName(
  current: string,
  computerName: string,
  operatorName: string,
): boolean {
  const value = current.trim();
  const host = computerName.trim();
  if (!value) return true;
  if (!host) return false;
  if (value === host) return true;
  if (value === composeSdPcName(host, operatorName)) return true;
  const suffix = ` (${host})`;
  return value.endsWith(suffix) && value.length > suffix.length;
}

/** Keep manual overrides; otherwise apply `Operator (Host)` or host-only. */
export function resolveSdPcName(
  current: string,
  computerName: string,
  operatorName: string,
): string {
  if (!isAutoSdPcName(current, computerName, operatorName)) {
    return current.trim();
  }
  return composeSdPcName(computerName, operatorName);
}

import type { AmsBridgePhase } from "@/store/amsBridgeStore";
import type { ServerPhase } from "@/store/serverStore";
import { mapAmsBridgeErrorDetail } from "@/lib/amsBridgeStatus";
import { mapServerErrorDetail } from "@/lib/serverStatus";

export function isPostUpdateConnectionFailure(opts: {
  serverUrl: string;
  smbPhase: ServerPhase;
  smbConnected: boolean;
  smbMessage: string;
  smbRefreshing: boolean;
  amsConfigured: boolean;
  amsPhase: AmsBridgePhase;
  amsConnected: boolean;
  amsMessage: string;
  amsRefreshing: boolean;
}): boolean {
  const {
    serverUrl,
    smbPhase,
    smbConnected,
    smbMessage,
    smbRefreshing,
    amsConfigured,
    amsPhase,
    amsConnected,
    amsMessage,
    amsRefreshing,
  } = opts;

  if (
    smbPhase === "checking" ||
    smbPhase === "uploading" ||
    smbRefreshing ||
    (amsConfigured && (amsPhase === "checking" || amsRefreshing))
  ) {
    return false;
  }

  const smbRequired = Boolean(serverUrl.trim());
  const amsRequired = amsConfigured;
  if (!smbRequired && !amsRequired) {
    return false;
  }

  const smbBad =
    smbRequired &&
    !smbConnected &&
    smbPhase === "error" &&
    mapServerErrorDetail(smbMessage).kind === "unreachable";

  const amsBad =
    amsRequired &&
    !amsConnected &&
    amsPhase === "error" &&
    mapAmsBridgeErrorDetail(amsMessage).kind === "unreachable";

  return (!smbRequired || smbBad) && (!amsRequired || amsBad);
}

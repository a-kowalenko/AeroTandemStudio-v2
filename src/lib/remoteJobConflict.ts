/** SMB promote failed because the destination job folder already exists. */
export function isRemoteJobExistsError(err: unknown): boolean {
  const text = String(err).toLowerCase();
  return (
    text.includes("remote_job_exists") ||
    text.includes("object_name_collision") ||
    text.includes("ziel existiert bereits") ||
    text.includes("zielordner existiert bereits")
  );
}

export type RemoteJobConflictAction =
  | "heal"
  | "heal_handoff"
  | "replace"
  | "unclear"
  | "retry";

export type RemoteJobConflictDialogState = {
  action: Exclude<RemoteJobConflictAction, "retry">;
  reason: string;
  folderName: string;
};

export function asConflictDialogAction(
  action: string,
): RemoteJobConflictDialogState["action"] {
  if (action === "heal" || action === "heal_handoff" || action === "replace") {
    return action;
  }
  return "unclear";
}

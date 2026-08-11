/** Present a QR hit: apply immediately, or confirm when switching customers. */

import type { Kunde, QrPreview } from "@/lib/tauri";
import {
  emptyCleanup,
  type QrCleanupResult,
} from "@/lib/qrCleanup";
import { discardQrPreviewBestEffort } from "@/lib/qrPreviewSession";
import {
  formatQrSuccess,
  kundeDisplayName,
  QR_SUCCESS_TITLE,
} from "@/lib/qrSuccess";
import { useKundeStore } from "@/store/kundeStore";
import {
  useUiStore,
  type DialogOptions,
} from "@/store/uiStore";

export type PresentQrHitInput = {
  kunde: Kunde;
  sourcePath?: string | null;
  preview?: QrPreview | null;
  notes?: string[];
  /**
   * Cleanup runs only after kundedata is applied (incl. after switch confirm).
   */
  runCleanup: () => QrCleanupResult | Promise<QrCleanupResult>;
  /**
   * When true (default), show SuccessDialog after apply / for switch confirm.
   * When false, only confirm-switch uses a dialog; caller embeds success options.
   */
  showDialog?: boolean;
};

export type PresentQrHitResult = {
  /** Kundedata was written to the session. */
  applied: boolean;
  /** User kept the existing QR session customer. */
  keptExisting: boolean;
  /** True when a switch confirm was shown. */
  switchConfirmShown: boolean;
  kundeName: string;
  cleanup: QrCleanupResult;
  successTitle: string;
  successOptions: DialogOptions;
  message: string;
};

function normHash(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** True when both sides identify the same booking/customer. */
export function isSameQrKunde(
  current: Pick<
    Kunde,
    "kunden_id_hash" | "booking_id_hash" | "vorname" | "nachname"
  >,
  scanned: Pick<
    Kunde,
    "kunden_id_hash" | "booking_id_hash" | "vorname" | "nachname"
  >,
): boolean {
  const curK = normHash(current.kunden_id_hash);
  const newK = normHash(scanned.kunden_id_hash);
  if (curK && newK) return curK === newK;

  const curB = normHash(current.booking_id_hash);
  const newB = normHash(scanned.booking_id_hash);
  if (curB && newB) return curB === newB;

  const curName = kundeDisplayName(current).toLowerCase();
  const newName = kundeDisplayName(scanned).toLowerCase();
  if (curName && newName) return curName === newName;

  return false;
}

/** Active QR session + scanned payload is a different customer. */
export function needsQrSwitchConfirm(
  current: Kunde,
  scanned: Kunde,
): boolean {
  if (current.form_mode !== "kunde") return false;
  return !isSameQrKunde(current, scanned);
}

function buildAppliedResult(
  kunde: Kunde,
  cleanup: QrCleanupResult,
  sourcePath: string | null | undefined,
  preview: QrPreview | null | undefined,
  notes: string[] | undefined,
  switchConfirmShown: boolean,
): PresentQrHitResult {
  const formatted = formatQrSuccess({
    kunde,
    cleanup,
    sourcePath,
    preview,
    notes,
  });
  return {
    applied: true,
    keptExisting: false,
    switchConfirmShown,
    kundeName: kundeDisplayName(kunde),
    cleanup,
    successTitle: formatted.title,
    successOptions: formatted.options,
    message: formatted.message,
  };
}

function askQrSwitch(opts: {
  previousName: string;
  nextName: string;
  preview?: QrPreview | null;
}): Promise<"switch" | "keep"> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice: "switch" | "keep") => {
      if (settled) return;
      settled = true;
      useUiStore.getState().closeDialog();
      resolve(choice);
    };

    const previous = opts.previousName.trim() || "Aktueller Kunde";
    const next = opts.nextName.trim() || "Neuer Kunde";

    useUiStore.getState().showSuccess(
      `Aktuell: ${previous}\nNeu: ${next}\n\nKundendaten wirklich wechseln? Medien bleiben erhalten.`,
      QR_SUCCESS_TITLE,
      {
        variant: "qr",
        highlight: next,
        autoCloseSecs: 0,
        qrPreview: opts.preview ?? null,
        actions: [
          {
            kind: "qr",
            label: "QR-Code",
            tone: "warning",
            summary: "Anderer Kunde erkannt",
            detail: `${previous} → ${next}`,
          },
        ],
        confirm: {
          secondaryLabel: "Behalten",
          primaryLabel: "Wechseln",
          onSecondary: () => finish("keep"),
          onPrimary: () => finish("switch"),
        },
      },
    );
  });
}

/**
 * Apply QR kundedata (with switch confirm when needed), run cleanup, optionally
 * show the success dialog.
 */
export async function presentQrHit(
  input: PresentQrHitInput,
): Promise<PresentQrHitResult> {
  const showDialog = input.showDialog !== false;
  const current = useKundeStore.getState().kunde;
  const scanned = input.kunde;
  const nextName = kundeDisplayName(scanned);
  const previousName = kundeDisplayName(current);

  if (needsQrSwitchConfirm(current, scanned)) {
    const choice = await askQrSwitch({
      previousName,
      nextName,
      preview: input.preview,
    });

    if (choice === "keep") {
      discardQrPreviewBestEffort(input.preview?.path);
      const cleanup = emptyCleanup();
      return {
        applied: false,
        keptExisting: true,
        switchConfirmShown: true,
        kundeName: previousName,
        cleanup,
        successTitle: QR_SUCCESS_TITLE,
        successOptions: {
          variant: "qr",
          highlight: previousName || "Kunde behalten",
          autoCloseSecs: 5,
          actions: [
            {
              kind: "qr",
              label: "QR-Code",
              tone: "skipped",
              summary: "Bestehenden Kunden behalten",
              detail: nextName
                ? `Neuer Scan ignoriert: ${nextName}`
                : "Neuer Scan ignoriert",
            },
          ],
        },
        message: "",
      };
    }

    useKundeStore.getState().applyFromQr(scanned, {
      preview: input.preview,
      sourcePath: input.sourcePath,
    });
    const cleanup = await input.runCleanup();
    const result = buildAppliedResult(
      scanned,
      cleanup,
      input.sourcePath,
      input.preview,
      input.notes,
      true,
    );
    if (showDialog) {
      useUiStore
        .getState()
        .showSuccess(result.message, result.successTitle, result.successOptions);
    }
    return result;
  }

  useKundeStore.getState().applyFromQr(scanned, {
    preview: input.preview,
    sourcePath: input.sourcePath,
  });
  const cleanup = await input.runCleanup();
  const result = buildAppliedResult(
    scanned,
    cleanup,
    input.sourcePath,
    input.preview,
    input.notes,
    false,
  );
  if (showDialog) {
    useUiStore
      .getState()
      .showSuccess(result.message, result.successTitle, result.successOptions);
  }
  return result;
}

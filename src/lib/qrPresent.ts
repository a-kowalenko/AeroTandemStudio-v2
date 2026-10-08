/** Present a QR hit: apply immediately, or confirm when switching / overriding manual. */

import type { Kunde, QrPreview } from "@/lib/tauri";
import {
  emptyCleanup,
  type QrCleanupResult,
} from "@/lib/qrCleanup";
import { discardQrPreviewBestEffort } from "@/lib/qrPreviewSession";
import { resolveQrDualFamily } from "@/lib/qrDualResolve";
import { createQrLookupUiController } from "@/lib/qrLookupProgress";
import { resolveQrNumericIds } from "@/lib/qrNumericResolve";
import {
  formatQrSuccess,
  kundeDisplayName,
  qrSuccessTitle,
} from "@/lib/qrSuccess";
import { tr } from "@/i18n";
import { useKundeStore } from "@/store/kundeStore";
import { useSessionRunStore } from "@/store/sessionRunStore";
import { useUiStore, type DialogOptions } from "@/store/uiStore";

export type PresentQrHitInput = {
  kunde: Kunde;
  dualFamily?: boolean | null;
  /** URL-only numeric IDs → AMS `mode=id` (not hash QR). */
  numericIds?: boolean | null;
  sourcePath?: string | null;
  preview?: QrPreview | null;
  notes?: string[];
  /**
   * Remove QR carrier (+ photo neighbors). Starts in parallel with AMS lookup when
   * no switch/override confirm is needed; otherwise runs after apply.
   */
  runCleanup: () => QrCleanupResult | Promise<QrCleanupResult>;
  /**
   * When true (default), show the session outcome card after apply, keep, or cancel.
   * Switch / override confirms still use SuccessDialog.
   * When false, the caller embeds the result (import or SD card adds extra rows).
   */
  showDialog?: boolean;
};

export type PresentQrHitResult = {
  /** Kundedata was written to the session. */
  applied: boolean;
  /** User kept the existing session customer (QR or manual). */
  keptExisting: boolean;
  /** True when a switch / manual-override confirm was shown. */
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

function trimField(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/** Label for confirm dialogs when name may be empty (IDs / contact only). */
export function manualKundeLabel(kunde: Kunde): string {
  const name = kundeDisplayName(kunde);
  if (name) return name;

  const id = trimField(kunde.kunden_id);
  const booking = trimField(kunde.booking_id);
  if (id || booking) {
    return [id && `#${id}`, booking && `Booking #${booking}`]
      .filter(Boolean)
      .join(" · ");
  }

  const email = trimField(kunde.email);
  if (email) return email;
  const telefon = trimField(kunde.telefon);
  if (telefon) return telefon;

  return tr("qr.confirm.manualEntry");
}

/**
 * Manual session has typed identity (name / plain IDs / contact).
 * Ignores gast alone (config defaults / derived display) and crew / products.
 */
export function hasMeaningfulManualKunde(current: Kunde): boolean {
  if (current.form_mode !== "manual") return false;
  return Boolean(
    trimField(current.vorname) ||
      trimField(current.nachname) ||
      trimField(current.kunden_id) ||
      trimField(current.booking_id) ||
      trimField(current.email) ||
      trimField(current.telefon),
  );
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

/** True when both sides share the same plain numeric ID pair. */
export function isSameNumericKunde(
  current: Pick<Kunde, "kunden_id" | "booking_id">,
  scanned: Pick<Kunde, "kunden_id" | "booking_id">,
): boolean {
  const curK = trimField(current.kunden_id);
  const newK = trimField(scanned.kunden_id);
  const curB = trimField(current.booking_id);
  const newB = trimField(scanned.booking_id);
  return Boolean(curK && newK && curB && newB && curK === newK && curB === newB);
}

/** Active QR session + scanned payload is a different customer. */
export function needsQrSwitchConfirm(
  current: Kunde,
  scanned: Kunde,
): boolean {
  if (current.form_mode !== "kunde") return false;
  return !isSameQrKunde(current, scanned);
}

/** Manual session with typed kundedata — QR would discard those fields. */
export function needsManualOverrideConfirm(
  current: Kunde,
  scanned?: Kunde,
): boolean {
  if (!hasMeaningfulManualKunde(current)) return false;
  if (scanned && isSameNumericKunde(current, scanned)) return false;
  return true;
}

function buildAppliedResult(
  kunde: Kunde,
  cleanup: QrCleanupResult,
  sourcePath: string | null | undefined,
  preview: QrPreview | null | undefined,
  notes: string[] | undefined,
  switchConfirmShown: boolean,
  /** Numeric URL QR without AMS enrichment — warning completion tile. */
  numericIdsOnly = false,
): PresentQrHitResult {
  const formatted = formatQrSuccess({
    kunde,
    cleanup,
    sourcePath,
    preview,
    notes,
    numericIdsOnly,
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

function buildKeptResult(opts: {
  previousLabel: string;
  nextName: string;
  summary: string;
  detail: string;
}): PresentQrHitResult {
  return {
    applied: false,
    keptExisting: true,
    switchConfirmShown: true,
    kundeName: opts.previousLabel,
    cleanup: emptyCleanup(),
    successTitle: qrSuccessTitle(),
    successOptions: {
      variant: "qr",
      highlight: opts.previousLabel || tr("qr.confirm.keepExistingSummary"),
      autoCloseSecs: 5,
      actions: [
        {
          kind: "qr",
          label: tr("qr.confirm.label"),
          tone: "skipped",
          summary: opts.summary,
          detail: opts.detail,
        },
      ],
    },
    message: "",
  };
}

function askQrConfirm(opts: {
  body: string;
  nextName: string;
  actionSummary: string;
  actionDetail: string;
  primaryLabel: string;
  secondaryLabel: string;
  preview?: QrPreview | null;
}): Promise<"apply" | "keep"> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice: "apply" | "keep") => {
      if (settled) return;
      settled = true;
      useUiStore.getState().closeDialog();
      resolve(choice);
    };

    const next = opts.nextName.trim() || tr("qr.confirm.newCustomer");

    useUiStore.getState().showSuccess(opts.body, qrSuccessTitle(), {
      variant: "qr",
      highlight: next,
      autoCloseSecs: 0,
      qrPreview: opts.preview ?? null,
      actions: [
        {
          kind: "qr",
          label: tr("qr.confirm.label"),
          tone: "warning",
          summary: opts.actionSummary,
          detail: opts.actionDetail,
        },
      ],
      confirm: {
        secondaryLabel: opts.secondaryLabel,
        primaryLabel: opts.primaryLabel,
        onSecondary: () => finish("keep"),
        onPrimary: () => finish("apply"),
      },
    });
  });
}

function askQrSwitch(opts: {
  previousName: string;
  nextName: string;
  preview?: QrPreview | null;
}): Promise<"apply" | "keep"> {
  const previous =
    opts.previousName.trim() || tr("qr.confirm.currentCustomer");
  const next = opts.nextName.trim() || tr("qr.confirm.newCustomer");
  return askQrConfirm({
    body: tr("qr.confirm.switchBody", { previous, next }),
    nextName: next,
    actionSummary: tr("qr.confirm.switchSummary"),
    actionDetail: `${previous} → ${next}`,
    primaryLabel: tr("qr.confirm.switchPrimary"),
    secondaryLabel: tr("qr.confirm.keep"),
    preview: opts.preview,
  });
}

function askManualOverride(opts: {
  previousLabel: string;
  nextName: string;
  preview?: QrPreview | null;
}): Promise<"apply" | "keep"> {
  const previous = opts.previousLabel.trim() || tr("qr.confirm.manualEntry");
  const next = opts.nextName.trim() || tr("qr.confirm.newCustomer");
  return askQrConfirm({
    body: tr("qr.confirm.overrideBody", { previous, next }),
    nextName: next,
    actionSummary: tr("qr.confirm.overrideSummary"),
    actionDetail: `${previous} → ${next}`,
    primaryLabel: tr("qr.confirm.overridePrimary"),
    secondaryLabel: tr("qr.confirm.keep"),
    preview: opts.preview,
  });
}

/** Same card as auto QR after import: title, customer highlight, action row, thumb. */
function presentQrSessionOutcome(result: PresentQrHitResult): void {
  const highlight =
    result.successOptions.highlight?.trim() ||
    result.kundeName.trim() ||
    tr("app.sd.customerRecognized");
  useSessionRunStore.getState().presentSessionRun({
    title: result.successTitle || tr("app.qr.recognized"),
    highlight,
    qrPreview: result.successOptions.qrPreview ?? null,
    actions: result.successOptions.actions ?? [],
    hold: false,
  });
}

function deliverQrOutcome(
  result: PresentQrHitResult,
  showOnSession: boolean,
): PresentQrHitResult {
  if (showOnSession) presentQrSessionOutcome(result);
  return result;
}

/**
 * Safe to delete QR carriers while AMS lookup runs: user cannot still choose
 * "keep existing" (that path skips cleanup).
 */
export function canCleanupDuringLookup(
  current: Kunde,
  scannedHint: Kunde,
): boolean {
  return (
    !needsQrSwitchConfirm(current, scannedHint) &&
    !needsManualOverrideConfirm(current, scannedHint)
  );
}

async function awaitCleanup(
  pending: Promise<QrCleanupResult> | null,
  runCleanup: () => QrCleanupResult | Promise<QrCleanupResult>,
): Promise<QrCleanupResult> {
  if (pending) {
    try {
      return await pending;
    } catch (e) {
      console.warn("QR cleanup (parallel) failed:", e);
      return emptyCleanup();
    }
  }
  return runCleanup();
}

/**
 * Apply QR kundedata (with switch / manual-override confirm when needed),
 * run cleanup (often in parallel with AMS lookup), and show the session card.
 * Dual-family QR resolves AMS hash-lookup + type choice first (Phase 45).
 * Numeric URL-only QR resolves AMS `mode=id` lookup into manual form.
 */
export async function presentQrHit(
  input: PresentQrHitInput,
): Promise<PresentQrHitResult> {
  const showDialog = input.showDialog !== false;

  let fromAms = false;
  let scanned: Kunde = input.kunde;

  const lookupHighlight = manualKundeLabel(input.kunde);
  const lookupUi = createQrLookupUiController({ highlight: lookupHighlight });

  const currentAtHit = useKundeStore.getState().kunde;
  const cleanupDuringLookup = canCleanupDuringLookup(
    currentAtHit,
    input.kunde,
  );
  const cleanupPromise: Promise<QrCleanupResult> | null = cleanupDuringLookup
    ? Promise.resolve().then(() => input.runCleanup())
    : null;

  const cancelledOutcome = (): PresentQrHitResult => ({
    applied: false,
    keptExisting: false,
    switchConfirmShown: false,
    kundeName: "",
    cleanup: emptyCleanup(),
    successTitle: qrSuccessTitle(),
    successOptions: {
      variant: "qr",
      highlight: tr("qr.confirm.keepExistingSummary"),
      autoCloseSecs: 5,
      actions: [
        {
          kind: "qr",
          label: tr("qr.confirm.label"),
          tone: "skipped",
          summary: tr("common.actions.cancel"),
          detail: tr("qr.dual.cancelled"),
        },
      ],
    },
    message: "",
  });

  try {
    if (input.numericIds) {
      const numeric = await resolveQrNumericIds(
        input.kunde,
        true,
        lookupUi.hooks,
      );
      if (numeric.kind === "cancelled") {
        discardQrPreviewBestEffort(input.preview?.path);
        void cleanupPromise;
        return deliverQrOutcome(cancelledOutcome(), showDialog);
      }
      if (numeric.kind === "resolved") {
        scanned = numeric.kunde;
        fromAms = numeric.fromAms;
      }
    } else {
      const dual = await resolveQrDualFamily(
        input.kunde,
        input.dualFamily,
        lookupUi.hooks,
      );
      if (dual.kind === "cancelled") {
        discardQrPreviewBestEffort(input.preview?.path);
        void cleanupPromise;
        return deliverQrOutcome(cancelledOutcome(), showDialog);
      }
      scanned = dual.kind === "resolved" ? dual.kunde : input.kunde;
    }

    const named = kundeDisplayName(scanned);
    const current = useKundeStore.getState().kunde;
    const nextName = named || manualKundeLabel(scanned);

    let confirmShown = false;

    if (needsQrSwitchConfirm(current, scanned)) {
      const previousName = kundeDisplayName(current);
      const choice = await askQrSwitch({
        previousName,
        nextName,
        preview: input.preview,
      });
      confirmShown = true;

      if (choice === "keep") {
        discardQrPreviewBestEffort(input.preview?.path);
        return deliverQrOutcome(
          buildKeptResult({
            previousLabel: previousName,
            nextName,
            summary: tr("qr.confirm.keepExistingSummary"),
            detail: nextName
              ? tr("qr.confirm.ignoredScanNamed", { name: nextName })
              : tr("qr.confirm.ignoredScan"),
          }),
          showDialog,
        );
      }
    } else if (needsManualOverrideConfirm(current, scanned)) {
      const previousLabel = manualKundeLabel(current);
      const choice = await askManualOverride({
        previousLabel,
        nextName,
        preview: input.preview,
      });
      confirmShown = true;

      if (choice === "keep") {
        discardQrPreviewBestEffort(input.preview?.path);
        return deliverQrOutcome(
          buildKeptResult({
            previousLabel,
            nextName,
            summary: tr("qr.confirm.keepManualSummary"),
            detail: nextName
              ? tr("qr.confirm.ignoredQrNamed", { name: nextName })
              : tr("qr.confirm.ignoredQr"),
          }),
          showDialog,
        );
      }
    }

    if (input.numericIds) {
      useKundeStore.getState().applyFromNumericQr(scanned, {
        preview: input.preview,
        sourcePath: input.sourcePath,
        fromAms,
      });
    } else {
      useKundeStore.getState().applyFromQr(scanned, {
        preview: input.preview,
        sourcePath: input.sourcePath,
      });
    }
    const cleanup = await awaitCleanup(cleanupPromise, input.runCleanup);
    // Hash/compact/legacy: never ids-only. Numeric: warn only when AMS missed.
    const numericIdsOnly = Boolean(input.numericIds) && !fromAms;
    const result = buildAppliedResult(
      scanned,
      cleanup,
      input.sourcePath,
      input.preview,
      input.notes,
      confirmShown,
      numericIdsOnly,
    );
    return deliverQrOutcome(result, showDialog);
  } finally {
    lookupUi.finish();
  }
}

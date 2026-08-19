import { useState, useEffect, useMemo, useRef, type InputHTMLAttributes, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Eye, Hash, QrCode, UserRound, PencilLine } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { DateField } from "@/components/ui/date-field";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { QrHitMeta } from "@/components/QrHitMeta";
import {
  QR_PREVIEW_FRAME_AR,
  QrSpotlightPreview,
} from "@/components/QrSpotlightPreview";
import { useConfigStore } from "@/store/configStore";
import { useKundeStore } from "@/store/kundeStore";
import { useUiStore } from "@/store/uiStore";
import { syncProductsFromMedia } from "@/lib/syncProductsFromMedia";
import { useAmsIdLookup } from "@/hooks/useAmsIdLookup";
import { lookupIdLengthHint, AMS_LOOKUP_MIN_ID_DIGITS } from "@/lib/amsLookup";
import {
  ORT_OPTIONS,
  crewNamesEqual,
  crewNamesForRole,
  crewPinnedSelfOption,
  normalizeManualEntryMode,
  withManualEntryMode,
  type ManualEntryMode,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { kundeDisplayName, fileBaseName } from "@/lib/qrSuccess";
import { CREATE_READY_IDS } from "@/lib/createReadyHints";

const CREW_TM_INPUT_ID = CREATE_READY_IDS.tandemmaster;
const CREW_VS_INPUT_ID = CREATE_READY_IDS.videospringer;
const KUNDE_ID_INPUT_ID = CREATE_READY_IDS.kundenId;

function isBlockingDialogOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"]'));
}

function isUserEditingElsewhere(except: HTMLElement): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === except) return false;
  if (active.closest('[role="dialog"]')) return false;
  return (
    active.tagName === "INPUT" ||
    active.tagName === "TEXTAREA" ||
    active.tagName === "SELECT" ||
    active.isContentEditable
  );
}

/** Focus Kunden-ID when idle. `false` = retry (dialog/disabled); `true` = done. */
function tryFocusKundenId(): boolean {
  if (isBlockingDialogOpen()) return false;
  const el = document.getElementById(KUNDE_ID_INPUT_ID);
  if (!(el instanceof HTMLInputElement) || el.disabled) return false;
  if (isUserEditingElsewhere(el)) return true;
  el.focus();
  return true;
}

function focusCrewField(id: string) {
  window.setTimeout(() => {
    document.getElementById(id)?.focus();
  }, 50);
}

function blurCrewField(id: string) {
  window.setTimeout(() => {
    const el = document.getElementById(id);
    if (el instanceof HTMLElement) el.blur();
  }, 0);
}

/** Scroll to crew and focus the first empty required field (QR/AMS). */
function scheduleCrewAttentionFocus(
  sectionRef: { current: HTMLElement | null },
): number | undefined {
  const state = useKundeStore.getState();
  if (!state.crewAttentionAfterQr) return undefined;
  const videoMode = (state.kunde.video_mode || "") as "" | "handcam" | "outside";
  const needsTm = !state.kunde.tandemmaster.trim();
  const needsVs =
    videoMode === "outside" && !state.kunde.videospringer.trim();
  if (!needsTm && !needsVs) return undefined;
  const focusId = needsTm ? CREW_TM_INPUT_ID : CREW_VS_INPUT_ID;
  return window.setTimeout(() => {
    sectionRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
    document.getElementById(focusId)?.focus();
  }, 80);
}

/** Allow digits and optional leading `#`; store only digits. */
function sanitizeNumericIdInput(raw: string): string {
  const withoutLeadingHash = raw.replace(/^#+/, "");
  return withoutLeadingHash.replace(/\D/g, "");
}

type FieldProps = {
  id?: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  type?: string;
  mono?: boolean;
  hint?: string;
  prefix?: ReactNode;
  inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"];
};

function Field({
  id,
  label,
  value,
  onChange,
  disabled,
  type = "text",
  mono,
  hint,
  prefix,
  inputMode,
}: FieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted">
        {label}
      </Label>
      <div className="relative">
        {prefix ? (
          <span
            className="pointer-events-none absolute left-2.5 top-1/2 z-10 -translate-y-1/2 text-muted"
            aria-hidden
          >
            {prefix}
          </span>
        ) : null}
        <Input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          inputMode={inputMode}
          className={cn(
            mono && "font-mono text-[13px]",
            disabled && "bg-card-elevated",
            prefix && "pl-8",
          )}
        />
      </div>
      {hint ? <p className="text-[10px] leading-snug text-muted">{hint}</p> : null}
    </div>
  );
}

type MediaOptionCellProps = {
  label: string;
  checked: boolean;
  paid: boolean;
  onChecked: (v: boolean) => void;
  onPaid: (v: boolean) => void;
  disabled?: boolean;
};

function MediaOptionCell({
  label,
  checked,
  paid,
  onChecked,
  onPaid,
  disabled,
}: MediaOptionCellProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border px-2.5 py-2 transition-colors",
        checked
          ? "border-primary/35 bg-primary-soft/40"
          : "border-border bg-card-elevated/80",
      )}
    >
      <label className="flex min-w-0 items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => {
            const on = v === true;
            onChecked(on);
            if (!on) onPaid(false);
          }}
          disabled={disabled}
        />
        <span className="truncate">{label}</span>
      </label>
      <label className="flex items-center justify-between gap-2 text-[11px] text-muted">
        <span>{t("form.media.paid")}</span>
        <Switch
          checked={paid}
          onCheckedChange={(v) => {
            const on = v === true;
            onPaid(on);
            if (on) onChecked(true);
          }}
          disabled={disabled}
          aria-label={t("form.media.paidAria", { label })}
        />
      </label>
    </div>
  );
}

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

type CustomerFormProps = {
  disabled?: boolean;
  /** When set, locks only Crew fields (Tandemmaster/Videospringer). Defaults to `disabled`. */
  crewDisabled?: boolean;
  /**
   * Locks QR↔Manuell toggle (and Scan-Frame button). Defaults to `disabled`.
   * Use during pipeline so Manual fields stay editable without mid-scan mode flips.
   */
  modeToggleDisabled?: boolean;
};

const FORM_MODES: { id: "kunde" | "manual"; icon: typeof QrCode }[] = [
  { id: "kunde", icon: QrCode },
  { id: "manual", icon: UserRound },
];

const MANUAL_ENTRY_MODES: ManualEntryMode[] = ["id", "oldschool", "lokal"];

/** Quiet chrome for session strip — reads as sidebar chrome, not form cards. */
const SESSION_STRIP_INPUT =
  "h-8 rounded-md border-transparent bg-transparent px-2.5 shadow-none placeholder:text-muted/70 hover:bg-foreground/[0.04] focus-visible:border-border/50 focus-visible:bg-foreground/[0.03] focus-visible:ring-1 focus-visible:ring-ring/35 disabled:bg-transparent disabled:opacity-60";

/**
 * Slim Dropzone / Datum strip for the sidebar top (scrolls with content, not sticky).
 * Rendered outside the padded form body so it sits flush under the app header.
 */
export function CustomerSessionStrip({ disabled }: CustomerFormProps) {
  const { t } = useTranslation();
  const kunde = useKundeStore((s) => s.kunde);
  const setField = useKundeStore((s) => s.setField);
  const busy = Boolean(disabled);

  return (
    <div className="grid grid-cols-2 items-center gap-1">
      <div className="min-w-0">
        <Combobox
          label={t("form.session.dropzone")}
          hideLabel
          value={kunde.ort}
          onChange={(v) => setField("ort", v)}
          options={ORT_OPTIONS}
          disabled={busy}
          placeholder={t("common.labels.dropzonePlaceholder")}
          inputClassName={SESSION_STRIP_INPUT}
        />
      </div>
      <div className="relative min-w-0 pl-1.5">
        <div
          className="pointer-events-none absolute top-1/2 left-0 h-4 w-px -translate-y-1/2 bg-border/60"
          aria-hidden
        />
        <DateField
          id={CREATE_READY_IDS.datum}
          label={t("create.ready.chips.date")}
          hideLabel
          value={kunde.datum}
          onChange={(v) => setField("datum", v)}
          disabled={busy}
          inputClassName={cn(SESSION_STRIP_INPUT, "tabular-nums")}
        />
      </div>
    </div>
  );
}

/** Compact QR ↔ Manuell toggle + optional Scan-Frame viewer. */
export function CustomerFormToolbar({
  disabled,
  modeToggleDisabled,
}: CustomerFormProps) {
  const { t } = useTranslation();
  const formMode = useKundeStore((s) => s.kunde.form_mode);
  const kunde = useKundeStore((s) => s.kunde);
  const qrSnapshot = useKundeStore((s) => s.qrSnapshot);
  const qrPreview = useKundeStore((s) => s.qrPreview);
  const qrPreviewSource = useKundeStore((s) => s.qrPreviewSource);
  const switchFormMode = useKundeStore((s) => s.switchFormMode);
  const busy = Boolean(modeToggleDisabled ?? disabled);
  const isQrMode = formMode === "kunde";
  const canSwitchToQr = Boolean(qrSnapshot);
  const [scanOpen, setScanOpen] = useState(false);
  const [showShadow, setShowShadow] = useState(true);
  const hasPreview = Boolean(qrPreview?.path?.trim());
  const sourceLabel = fileBaseName(qrPreviewSource);
  /** Prefer immutable QR snapshot for hit meta; fall back to current form. */
  const metaKunde = qrSnapshot ?? kunde;
  const metaMode =
    metaKunde.video_mode === "handcam" || metaKunde.video_mode === "outside"
      ? metaKunde.video_mode
      : "";
  const metaFoto =
    metaMode === "handcam" ? metaKunde.handcam_foto : metaKunde.outside_foto;
  const metaVideo =
    metaMode === "handcam" ? metaKunde.handcam_video : metaKunde.outside_video;

  useEffect(() => {
    if (!hasPreview && scanOpen) setScanOpen(false);
  }, [hasPreview, scanOpen]);

  // Fixed landscape frame (max-h × 16:9) drives width; +3rem for dialog p-6. Floor ~22rem so meta stays usable.
  const scanDialogWidth = `min(max(min(22rem, calc(100vw - 2rem)), calc(min(50vh, 28rem) * ${QR_PREVIEW_FRAME_AR} + 3rem)), calc(100vw - 2rem))`;

  return (
    <div className="inline-flex shrink-0 items-center gap-1.5">
      {hasPreview && qrPreview ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 w-7 px-0"
            disabled={busy}
            title={t("form.toolbar.scanFrame")}
            aria-label={t("form.toolbar.scanFrame")}
            onClick={() => {
              setShowShadow(true);
              setScanOpen(true);
            }}
          >
            <Eye className="h-3.5 w-3.5" />
          </Button>
          <Dialog open={scanOpen} onOpenChange={setScanOpen}>
            <DialogContent
              className="flex w-auto max-w-[min(56rem,calc(100vw-2rem))] flex-col gap-4"
              style={{ width: scanDialogWidth }}
            >
              <DialogHeader className="shrink-0">
                <DialogTitle>{t("form.toolbar.scanTitle")}</DialogTitle>
                <DialogDescription>
                  {t("form.toolbar.scanDescription")}
                </DialogDescription>
              </DialogHeader>
              <QrSpotlightPreview
                preview={qrPreview}
                showSpotlight={showShadow}
                className="max-w-full"
              />
              <div className="grid w-full shrink-0 gap-3 min-[28rem]:grid-cols-[1fr_auto] min-[28rem]:items-stretch">
                <QrHitMeta
                  className="min-w-0"
                  fileName={sourceLabel || null}
                  displayName={kundeDisplayName(metaKunde) || null}
                  customerHash={metaKunde.kunden_id_hash}
                  bookingHash={metaKunde.booking_id_hash}
                  media={
                    metaMode || metaFoto || metaVideo
                      ? {
                          mode: metaMode,
                          foto: Boolean(metaFoto),
                          video: Boolean(metaVideo),
                        }
                      : null
                  }
                />
                <div className="flex flex-col gap-3 min-[28rem]:w-[10.5rem] min-[28rem]:justify-between">
                  <label
                    htmlFor="qr-scan-shadow"
                    className="flex h-fit cursor-pointer items-center gap-2.5 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5"
                  >
                    <Switch
                      id="qr-scan-shadow"
                      checked={showShadow}
                      onCheckedChange={setShowShadow}
                    />
                    <span className="text-sm font-medium text-foreground">
                      {t("form.toolbar.shadow")}
                    </span>
                  </label>
                  <Button
                    type="button"
                    className="w-full min-[28rem]:mt-auto"
                    onClick={() => setScanOpen(false)}
                  >
                    {t("common.actions.close")}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </>
      ) : null}

      <div
        role="group"
        aria-label={t("form.toolbar.modeAria")}
        className="inline-flex shrink-0 items-center rounded-md bg-card-elevated p-0.5 ring-1 ring-border"
      >
        {FORM_MODES.map(({ id, icon: Icon }) => {
          const active = id === "kunde" ? isQrMode : !isQrMode;
          const qrDisabled = id === "kunde" && !isQrMode && !canSwitchToQr;
          const label =
            id === "kunde" ? t("form.toolbar.qr") : t("form.toolbar.manual");
          return (
            <button
              key={id}
              type="button"
              disabled={busy || qrDisabled}
              aria-pressed={active}
              title={
                qrDisabled
                  ? t("form.toolbar.noQrSession")
                  : id === "kunde"
                    ? t("form.toolbar.restoreQr")
                    : t("form.toolbar.manualEntry")
              }
              onClick={() => switchFormMode(id)}
              className={cn(
                "inline-flex items-center gap-1 rounded-[5px] px-2.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase transition-colors",
                "disabled:pointer-events-none disabled:opacity-50",
                active
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted hover:text-foreground",
              )}
            >
              <Icon className="h-3 w-3" />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ManualEntryModeToggle({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const patch = useKundeStore((s) => s.patch);
  const clearAmsLookup = useKundeStore((s) => s.clearAmsLookup);
  const config = useConfigStore((s) => s.config);
  const persistConfig = useConfigStore((s) => s.persist);
  const entryMode = normalizeManualEntryMode(
    config?.manual_entry_mode,
    config?.oldschool_mode ?? false,
  );
  const busy = Boolean(disabled);

  async function setManualEntryMode(next: ManualEntryMode) {
    if (!config || entryMode === next) return;
    await persistConfig(withManualEntryMode(config, next));
    clearAmsLookup();
    if (next === "id") {
      patch({ email: null, telefon: null });
    } else if (next === "lokal") {
      patch({
        email: null,
        telefon: null,
        kunden_id: null,
        booking_id: null,
      });
    } else {
      patch({ kunden_id: null, booking_id: null });
    }
  }

  return (
    <div
      role="group"
      aria-label={t("form.manual.modeAria")}
      className="flex w-full items-center rounded-md bg-card-elevated p-0.5 ring-1 ring-border"
    >
      {MANUAL_ENTRY_MODES.map((id) => {
        const label =
          id === "id"
            ? t("form.manual.id")
            : id === "oldschool"
              ? t("form.manual.contact")
              : t("form.manual.local");
        return (
        <button
          key={id}
          type="button"
          disabled={busy || !config}
          aria-pressed={entryMode === id}
          onClick={() => void setManualEntryMode(id)}
          className={cn(
            "flex-1 rounded-[5px] px-2.5 py-1 text-[11px] font-semibold tracking-wide uppercase transition-colors",
            "disabled:pointer-events-none disabled:opacity-50",
            entryMode === id
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted hover:text-foreground",
          )}
        >
          {label}
        </button>
        );
      })}
    </div>
  );
}

export function CustomerForm({
  disabled,
  crewDisabled,
  modeToggleDisabled,
}: CustomerFormProps) {
  const { t } = useTranslation();
  const kunde = useKundeStore((s) => s.kunde);
  const setField = useKundeStore((s) => s.setField);
  const patch = useKundeStore((s) => s.patch);
  const setVideoMode = useKundeStore((s) => s.setVideoMode);
  const qrRevision = useKundeStore((s) => s.qrRevision);
  const amsLookupLocked = useKundeStore((s) => s.amsLookupLocked);
  const amsLookupRevision = useKundeStore((s) => s.amsLookupRevision);
  const unlockAmsLookup = useKundeStore((s) => s.unlockAmsLookup);
  const relockAmsLookup = useKundeStore((s) => s.relockAmsLookup);
  const kundenIdFocusPending = useKundeStore((s) => s.kundenIdFocusPending);
  const clearKundenIdFocus = useKundeStore((s) => s.clearKundenIdFocus);
  const crewAttentionAfterQr = useKundeStore((s) => s.crewAttentionAfterQr);
  const dialogKind = useUiStore((s) => s.dialogKind);
  const dialogVariant = useUiStore((s) => s.dialogVariant);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const loading = useUiStore((s) => s.loading);
  const config = useConfigStore((s) => s.config);
  const entryMode = normalizeManualEntryMode(
    config?.manual_entry_mode,
    config?.oldschool_mode ?? false,
  );
  const nameEntry = entryMode === "oldschool" || entryMode === "lokal";
  const oldschool = entryMode === "oldschool";
  const crewList = config?.crew_list;
  const operatorName = config?.operator_name ?? "";
  const tandemmasterOptions = useMemo(
    () => crewNamesForRole(crewList, "tandemmaster"),
    [crewList],
  );
  const videospringerOptions = useMemo(
    () => crewNamesForRole(crewList, "videospringer"),
    [crewList],
  );
  const mode = (kunde.video_mode || "") as "" | "handcam" | "outside";
  // TM↔VS exclusion only when VS is relevant (Outside). Kept/default VS must not
  // block TM selection in Handcam where the VS combobox is hidden.
  const crewRoleExclusionActive = mode === "outside";
  const tmBlockedByVs =
    crewRoleExclusionActive && Boolean(kunde.videospringer.trim());
  const vsBlockedByTm =
    crewRoleExclusionActive && Boolean(kunde.tandemmaster.trim());
  const tandemmasterPinned = useMemo(() => {
    const pin = crewPinnedSelfOption(
      crewList,
      "tandemmaster",
      operatorName,
      {
        disabled:
          crewRoleExclusionActive &&
          crewNamesEqual(operatorName, kunde.videospringer),
      },
    );
    return pin ? [pin] : [];
  }, [crewList, operatorName, kunde.videospringer, crewRoleExclusionActive]);
  const videospringerPinned = useMemo(() => {
    const pin = crewPinnedSelfOption(
      crewList,
      "videospringer",
      operatorName,
      {
        disabled:
          crewRoleExclusionActive &&
          crewNamesEqual(operatorName, kunde.tandemmaster),
      },
    );
    return pin ? [pin] : [];
  }, [crewList, operatorName, kunde.tandemmaster, crewRoleExclusionActive]);
  const tmDisabledValues = useMemo(
    () => (tmBlockedByVs ? [kunde.videospringer.trim()] : []),
    [tmBlockedByVs, kunde.videospringer],
  );
  const vsDisabledValues = useMemo(
    () => (vsBlockedByTm ? [kunde.tandemmaster.trim()] : []),
    [vsBlockedByTm, kunde.tandemmaster],
  );
  const tmConflict =
    crewRoleExclusionActive &&
    crewNamesEqual(kunde.tandemmaster, kunde.videospringer) &&
    Boolean(kunde.tandemmaster.trim());
  const vsConflict = tmConflict;
  const [nameLocked, setNameLocked] = useState(true);
  const crewSectionRef = useRef<HTMLDivElement>(null);
  const qrSuccessDialogWasOpen = useRef(false);
  const focusedAmsLookupRevision = useRef(0);

  const isQrMode = kunde.form_mode === "kunde";
  const busy = Boolean(disabled);
  const lookupStatus = useAmsIdLookup({
    enabled: !busy && !isQrMode && entryMode === "id",
    config,
  });
  // Crew is independent of import/QR locks; only freeze during Vorgang create unless overridden.
  const crewBusy = Boolean(crewDisabled ?? disabled);
  const modeToggleBusy = Boolean(modeToggleDisabled ?? disabled);
  const productsFromQr =
    isQrMode &&
    (kunde.handcam_foto ||
      kunde.handcam_video ||
      kunde.outside_foto ||
      kunde.outside_video);
  const productsLocked =
    (productsFromQr && nameLocked) || amsLookupLocked;
  const identityLocked = isQrMode ? nameLocked : amsLookupLocked;
  const showAmsLockButton = !isQrMode && amsLookupRevision > 0;

  const warnTandemmaster =
    crewAttentionAfterQr && !kunde.tandemmaster.trim();
  const warnVideospringer =
    crewAttentionAfterQr &&
    mode === "outside" &&
    !kunde.videospringer.trim();

  // Re-lock after QR apply (including Auto-QR / Medienliste / Vorschau).
  useEffect(() => {
    if (qrRevision > 0) setNameLocked(true);
  }, [qrRevision]);

  // After QR success dialog closes: scroll/focus first missing crew field.
  useEffect(() => {
    const open = dialogKind === "success" && dialogVariant === "qr";
    let focusTimer: number | undefined;
    if (qrSuccessDialogWasOpen.current && !open) {
      focusTimer = scheduleCrewAttentionFocus(crewSectionRef);
    }
    qrSuccessDialogWasOpen.current = open;
    return () => {
      if (focusTimer !== undefined) window.clearTimeout(focusTimer);
    };
  }, [dialogKind, dialogVariant]);

  // After AMS apply (dialogs already closed): same crew scroll/focus.
  useEffect(() => {
    if (amsLookupRevision <= 0) {
      focusedAmsLookupRevision.current = 0;
      return;
    }
    if (focusedAmsLookupRevision.current >= amsLookupRevision) return;
    if (dialogKind != null) return;
    focusedAmsLookupRevision.current = amsLookupRevision;
    const focusTimer = scheduleCrewAttentionFocus(crewSectionRef);
    return () => {
      if (focusTimer !== undefined) window.clearTimeout(focusTimer);
    };
  }, [amsLookupRevision, dialogKind]);

  // After import without QR / QR miss: focus Kunden-ID once overlays close.
  useEffect(() => {
    if (!kundenIdFocusPending) return;

    const emptyId = !(kunde.kunden_id ?? "").trim();
    const nameStarted = Boolean(
      (kunde.vorname ?? "").trim() || (kunde.nachname ?? "").trim(),
    );
    const modeOk = !isQrMode && entryMode === "id";
    if (!modeOk || !emptyId || nameStarted || identityLocked) {
      clearKundenIdFocus();
      return;
    }

    const blocked =
      busy ||
      dialogKind != null ||
      settingsOpen ||
      loading ||
      crewAttentionAfterQr;
    if (blocked) return;

    let observer: MutationObserver | null = null;
    const finish = () => {
      clearKundenIdFocus();
      observer?.disconnect();
      observer = null;
    };
    const timer = window.setTimeout(() => {
      if (tryFocusKundenId()) {
        finish();
        return;
      }
      observer = new MutationObserver(() => {
        if (tryFocusKundenId()) finish();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }, 50);
    return () => {
      window.clearTimeout(timer);
      observer?.disconnect();
    };
  }, [
    busy,
    clearKundenIdFocus,
    crewAttentionAfterQr,
    dialogKind,
    entryMode,
    identityLocked,
    isQrMode,
    kunde.kunden_id,
    kunde.nachname,
    kunde.vorname,
    kundenIdFocusPending,
    loading,
    settingsOpen,
  ]);

  function focusVideospringerIfEmpty() {
    const state = useKundeStore.getState();
    const videoMode = state.kunde.video_mode || "";
    if (
      videoMode === "outside" &&
      !state.kunde.videospringer.trim()
    ) {
      focusCrewField(CREW_VS_INPUT_ID);
      return false;
    }
    return true;
  }

  /** End crew dropdown workflow: blur so the list cannot reopen. */
  function finishCrewAttentionWorkflow(inputId: string) {
    blurCrewField(inputId);
    const state = useKundeStore.getState();
    if (!state.crewAttentionAfterQr) return;

    const k = state.kunde;
    const videoMode = k.video_mode || "";
    const tmOk = Boolean(k.tandemmaster.trim());
    const vsOk =
      videoMode !== "outside" || Boolean(k.videospringer.trim());
    if (!tmOk || !vsOk) return;

    // Orange attention satisfied — only then ask to pulse Erstellen if it unlocks.
    state.clearCrewAttentionAfterQr();
    useUiStore.getState().requestCreateReadyPulse();
  }

  function onTandemmasterChange(v: string) {
    setField("tandemmaster", v);
  }

  function onVideospringerChange(v: string) {
    setField("videospringer", v);
  }

  function onTandemmasterSelect(v: string) {
    const k = useKundeStore.getState().kunde;
    if (
      k.video_mode === "outside" &&
      crewNamesEqual(v, k.videospringer)
    ) {
      setField("tandemmaster", "");
      return;
    }
    if (focusVideospringerIfEmpty()) {
      finishCrewAttentionWorkflow(CREW_TM_INPUT_ID);
    }
  }

  function onVideospringerSelect(v: string) {
    const k = useKundeStore.getState().kunde;
    if (
      k.video_mode === "outside" &&
      crewNamesEqual(v, k.tandemmaster)
    ) {
      setField("videospringer", "");
      return;
    }
    finishCrewAttentionWorkflow(CREW_VS_INPUT_ID);
  }

  function syncGastFromName(vorname: string, nachname: string) {
    const gast = `${vorname} ${nachname}`.trim();
    patch({ vorname, nachname, gast });
  }

  // Gast / Anzeigename immer aus Vor- und Nachname ableiten.
  useEffect(() => {
    const next = `${kunde.vorname ?? ""} ${kunde.nachname ?? ""}`.trim();
    if (kunde.gast !== next) {
      setField("gast", next);
    }
  }, [kunde.vorname, kunde.nachname, kunde.gast, setField]);

  return (
    <div className="space-y-5">
      <section className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
            {t("form.customer.section")}
          </h3>
          <div className="flex items-center gap-1.5">
            {isQrMode ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                disabled={busy}
                onClick={() => setNameLocked((v) => !v)}
              >
                <PencilLine className="h-3 w-3" />
                {nameLocked ? t("common.actions.edit") : t("form.customer.lock")}
              </Button>
            ) : showAmsLockButton ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                disabled={busy}
                onClick={() =>
                  amsLookupLocked ? unlockAmsLookup() : relockAmsLookup()
                }
              >
                <PencilLine className="h-3 w-3" />
                {amsLookupLocked ? t("common.actions.edit") : t("form.customer.lock")}
              </Button>
            ) : null}
            <CustomerFormToolbar
              disabled={busy}
              modeToggleDisabled={modeToggleBusy}
            />
          </div>
        </div>

        {!isQrMode ? <ManualEntryModeToggle disabled={busy} /> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          {isQrMode ? (
            <>
              <Field
                id={CREATE_READY_IDS.vorname}
                label={t("form.customer.firstName")}
                value={kunde.vorname ?? ""}
                onChange={(v) => syncGastFromName(v, kunde.nachname ?? "")}
                disabled={busy || nameLocked}
              />
              <Field
                label={t("form.customer.lastName")}
                value={kunde.nachname ?? ""}
                onChange={(v) => syncGastFromName(kunde.vorname ?? "", v)}
                disabled={busy || nameLocked}
              />
              <Field
                label={t("form.customer.customerIdHash")}
                value={kunde.kunden_id_hash ?? ""}
                onChange={(v) => setField("kunden_id_hash", v || null)}
                disabled={busy || nameLocked}
                mono
              />
              <Field
                label={t("form.customer.bookingIdHash")}
                value={kunde.booking_id_hash ?? ""}
                onChange={(v) => setField("booking_id_hash", v || null)}
                disabled={busy || nameLocked}
                mono
              />
            </>
          ) : (
            <>
              {!nameEntry ? (
                <>
                  <Field
                    id={KUNDE_ID_INPUT_ID}
                    label={t("form.customer.customerId")}
                    value={kunde.kunden_id ?? ""}
                    onChange={(v) =>
                      setField("kunden_id", sanitizeNumericIdInput(v) || null)
                    }
                    disabled={busy || identityLocked}
                    mono
                    inputMode="numeric"
                    prefix={<Hash className="size-3.5 shrink-0" strokeWidth={2.25} />}
                    hint={
                      lookupIdLengthHint(kunde.kunden_id)
                        ? t("form.customer.idMinDigits", {
                            count: AMS_LOOKUP_MIN_ID_DIGITS,
                          })
                        : undefined
                    }
                  />
                  <Field
                    id={CREATE_READY_IDS.bookingId}
                    label={t("form.customer.bookingId")}
                    value={kunde.booking_id ?? ""}
                    onChange={(v) =>
                      setField("booking_id", sanitizeNumericIdInput(v) || null)
                    }
                    disabled={busy || identityLocked}
                    mono
                    inputMode="numeric"
                    prefix={<Hash className="size-3.5 shrink-0" strokeWidth={2.25} />}
                    hint={
                      lookupIdLengthHint(kunde.booking_id)
                        ? t("form.customer.idMinDigits", {
                            count: AMS_LOOKUP_MIN_ID_DIGITS,
                          })
                        : undefined
                    }
                  />
                  {lookupStatus.text ? (
                    <p
                      className={cn(
                        "sm:col-span-2 text-[11px] leading-snug",
                        lookupStatus.kind === "error" ||
                          lookupStatus.kind === "not_found"
                          ? "text-destructive"
                          : lookupStatus.kind === "found"
                            ? "text-foreground/80"
                            : "text-muted",
                      )}
                      role="status"
                    >
                      {lookupStatus.text}
                    </p>
                  ) : null}
                </>
              ) : null}
              <Field
                id={CREATE_READY_IDS.vorname}
                label={t("form.customer.firstName")}
                value={kunde.vorname ?? ""}
                onChange={(v) => syncGastFromName(v, kunde.nachname ?? "")}
                disabled={busy || identityLocked}
              />
              <Field
                label={t("form.customer.lastName")}
                value={kunde.nachname ?? ""}
                onChange={(v) => syncGastFromName(kunde.vorname ?? "", v)}
                disabled={busy || identityLocked}
              />
              {oldschool ? (
                <>
                  <Field
                    id={CREATE_READY_IDS.email}
                    label={t("form.customer.email")}
                    value={kunde.email ?? ""}
                    onChange={(v) => setField("email", v || null)}
                    disabled={busy}
                    type="email"
                  />
                  <Field
                    label={t("form.customer.phone")}
                    value={kunde.telefon ?? ""}
                    onChange={(v) => setField("telefon", v || null)}
                    disabled={busy}
                  />
                </>
              ) : null}
            </>
          )}
        </div>
      </section>
      <Section title={t("form.crew.section")}>
        <div
          ref={crewSectionRef}
          className={cn(
            "grid gap-3",
            mode === "outside" ? "sm:grid-cols-2" : "sm:grid-cols-1",
          )}
        >
          <Combobox
            id={CREW_TM_INPUT_ID}
            label={t("create.ready.chips.tandemmaster")}
            value={kunde.tandemmaster}
            onChange={onTandemmasterChange}
            onSelectOption={onTandemmasterSelect}
            options={tandemmasterOptions}
            pinnedOptions={tandemmasterPinned}
            disabledValues={tmDisabledValues}
            disabled={crewBusy}
            placeholder={t("form.crew.namePlaceholder")}
            warning={warnTandemmaster}
            error={tmConflict ? t("create.validation.crewConflictShort") : undefined}
          />
          {mode === "outside" ? (
            <Combobox
              id={CREW_VS_INPUT_ID}
              label={t("create.ready.chips.videospringer")}
              value={kunde.videospringer}
              onChange={onVideospringerChange}
              onSelectOption={onVideospringerSelect}
              options={videospringerOptions}
              pinnedOptions={videospringerPinned}
              disabledValues={vsDisabledValues}
              disabled={crewBusy}
              placeholder={t("form.crew.namePlaceholder")}
              warning={warnVideospringer}
              error={vsConflict ? t("create.validation.crewConflictShort") : undefined}
            />
          ) : null}
        </div>
      </Section>

      <Section title={t("form.media.section")}>
        <div
          id={CREATE_READY_IDS.produkt}
          tabIndex={-1}
          className={cn(
            "inline-flex w-full max-w-sm rounded-lg border border-border bg-card-elevated/80 p-1 outline-none",
            (busy || productsLocked) && "opacity-60",
          )}
          role="group"
          aria-label={t("form.media.modeAria")}
        >
          {(
            [
              ["handcam", t("form.media.handcam")],
              ["outside", t("form.media.outside")],
            ] as const
          ).map(([value, label]) => {
            const selected = mode === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={busy || productsLocked}
                className={cn(
                  "flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "disabled:cursor-not-allowed",
                  selected
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted hover:bg-card hover:text-foreground",
                )}
                onClick={() => {
                  if (mode === value) return;
                  setVideoMode(value);
                  if (
                    value === "outside" &&
                    crewNamesEqual(
                      useKundeStore.getState().kunde.tandemmaster,
                      useKundeStore.getState().kunde.videospringer,
                    )
                  ) {
                    setField("videospringer", "");
                  }
                  syncProductsFromMedia();
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        {!mode ? (
          <p className="text-[11px] text-muted">
            {t("form.media.chooseMode")}
          </p>
        ) : null}

        {mode === "handcam" ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <MediaOptionCell
              label={t("form.media.handcamPhoto")}
              checked={kunde.handcam_foto}
              paid={kunde.ist_bezahlt_handcam_foto}
              onChecked={(v) => setField("handcam_foto", v)}
              onPaid={(v) => setField("ist_bezahlt_handcam_foto", v)}
              disabled={busy || productsLocked}
            />
            <MediaOptionCell
              label={t("form.media.handcamVideo")}
              checked={kunde.handcam_video}
              paid={kunde.ist_bezahlt_handcam_video}
              onChecked={(v) => setField("handcam_video", v)}
              onPaid={(v) => setField("ist_bezahlt_handcam_video", v)}
              disabled={busy || productsLocked}
            />
          </div>
        ) : null}

        {mode === "outside" ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <MediaOptionCell
              label={t("form.media.outsidePhoto")}
              checked={kunde.outside_foto}
              paid={kunde.ist_bezahlt_outside_foto}
              onChecked={(v) => setField("outside_foto", v)}
              onPaid={(v) => setField("ist_bezahlt_outside_foto", v)}
              disabled={busy || productsLocked}
            />
            <MediaOptionCell
              label={t("form.media.outsideVideo")}
              checked={kunde.outside_video}
              paid={kunde.ist_bezahlt_outside_video}
              onChecked={(v) => setField("outside_video", v)}
              onPaid={(v) => setField("ist_bezahlt_outside_video", v)}
              disabled={busy || productsLocked}
            />
          </div>
        ) : null}

        {productsLocked ? (
          <p className="text-[11px] text-muted">
            {amsLookupLocked
              ? t("form.media.lockedAms")
              : t("form.media.lockedQr")}
          </p>
        ) : null}
      </Section>
    </div>
  );
}

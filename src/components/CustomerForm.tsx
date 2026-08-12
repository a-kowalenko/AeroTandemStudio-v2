import { useState, useEffect, useMemo, useRef, type InputHTMLAttributes, type ReactNode } from "react";
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
import { QrSpotlightPreview } from "@/components/QrSpotlightPreview";
import { useConfigStore } from "@/store/configStore";
import { useKundeStore } from "@/store/kundeStore";
import { useUiStore } from "@/store/uiStore";
import { syncProductsFromMedia } from "@/lib/syncProductsFromMedia";
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

const CREW_TM_INPUT_ID = "crew-tandemmaster";
const CREW_VS_INPUT_ID = "crew-videospringer";
const CREW_ROLE_CONFLICT =
  "Dieselbe Person kann nicht Tandemmaster und Videospringer zugleich sein.";


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

/** Allow digits and optional leading `#`; store only digits. */
function sanitizeNumericIdInput(raw: string): string {
  const withoutLeadingHash = raw.replace(/^#+/, "");
  return withoutLeadingHash.replace(/\D/g, "");
}

type FieldProps = {
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
      <Label className="text-xs text-muted">{label}</Label>
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
        <span>Bezahlt</span>
        <Switch
          checked={paid}
          onCheckedChange={(v) => {
            const on = v === true;
            onPaid(on);
            if (on) onChecked(true);
          }}
          disabled={disabled}
          aria-label={`${label} bezahlt`}
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

const FORM_MODES: { id: "kunde" | "manual"; label: string; icon: typeof QrCode }[] = [
  { id: "kunde", label: "QR", icon: QrCode },
  { id: "manual", label: "Manuell", icon: UserRound },
];

const MANUAL_ENTRY_MODES: { id: ManualEntryMode; label: string }[] = [
  { id: "id", label: "ID" },
  { id: "oldschool", label: "Kontakt" },
  { id: "lokal", label: "Lokal" },
];

/** Quiet chrome for session strip — reads as sidebar chrome, not form cards. */
const SESSION_STRIP_INPUT =
  "h-8 rounded-md border-transparent bg-transparent px-2.5 shadow-none placeholder:text-muted/70 hover:bg-foreground/[0.04] focus-visible:border-border/50 focus-visible:bg-foreground/[0.03] focus-visible:ring-1 focus-visible:ring-ring/35 disabled:bg-transparent disabled:opacity-60";

/**
 * Slim Dropzone / Datum strip for the sidebar top (scrolls with content, not sticky).
 * Rendered outside the padded form body so it sits flush under the app header.
 */
export function CustomerSessionStrip({ disabled }: CustomerFormProps) {
  const kunde = useKundeStore((s) => s.kunde);
  const setField = useKundeStore((s) => s.setField);
  const busy = Boolean(disabled);

  return (
    <div className="grid grid-cols-2 items-center gap-1">
      <div className="min-w-0">
        <Combobox
          label="Dropzone"
          hideLabel
          value={kunde.ort}
          onChange={(v) => setField("ort", v)}
          options={ORT_OPTIONS}
          disabled={busy}
          placeholder="Dropzone…"
          inputClassName={SESSION_STRIP_INPUT}
        />
      </div>
      <div className="relative min-w-0 pl-1.5">
        <div
          className="pointer-events-none absolute top-1/2 left-0 h-4 w-px -translate-y-1/2 bg-border/60"
          aria-hidden
        />
        <DateField
          label="Datum"
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

  const scanFrameAr =
    qrPreview && qrPreview.width > 0 && qrPreview.height > 0
      ? qrPreview.width / qrPreview.height
      : 16 / 9;
  // Frame (max-h × aspect) drives width; +3rem for dialog p-6. Floor ~22rem so meta stays usable.
  const scanDialogWidth = `min(max(min(22rem, calc(100vw - 2rem)), calc(min(50vh, 28rem) * ${scanFrameAr} + 3rem)), calc(100vw - 2rem))`;

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
            title="QR-Scan-Frame anzeigen"
            aria-label="QR-Scan-Frame anzeigen"
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
                <DialogTitle>QR-Scan</DialogTitle>
                <DialogDescription>
                  Treffer-Frame dieser Session
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
                      Schatten
                    </span>
                  </label>
                  <Button
                    type="button"
                    className="w-full min-[28rem]:mt-auto"
                    onClick={() => setScanOpen(false)}
                  >
                    Schließen
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </>
      ) : null}

      <div
        role="group"
        aria-label="Eingabemodus"
        className="inline-flex shrink-0 items-center rounded-md bg-card-elevated p-0.5 ring-1 ring-border"
      >
        {FORM_MODES.map(({ id, label, icon: Icon }) => {
          const active = id === "kunde" ? isQrMode : !isQrMode;
          const qrDisabled = id === "kunde" && !isQrMode && !canSwitchToQr;
          return (
            <button
              key={id}
              type="button"
              disabled={busy || qrDisabled}
              aria-pressed={active}
              title={
                qrDisabled
                  ? "Kein QR in dieser Session — zuerst scannen"
                  : id === "kunde"
                    ? "QR-Daten wiederherstellen"
                    : "Zur manuellen Eingabe"
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
  const patch = useKundeStore((s) => s.patch);
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
      aria-label="Manueller Eingabemodus"
      className="flex w-full items-center rounded-md bg-card-elevated p-0.5 ring-1 ring-border"
    >
      {MANUAL_ENTRY_MODES.map(({ id, label }) => (
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
      ))}
    </div>
  );
}

export function CustomerForm({
  disabled,
  crewDisabled,
  modeToggleDisabled,
}: CustomerFormProps) {
  const kunde = useKundeStore((s) => s.kunde);
  const setField = useKundeStore((s) => s.setField);
  const patch = useKundeStore((s) => s.patch);
  const setVideoMode = useKundeStore((s) => s.setVideoMode);
  const qrRevision = useKundeStore((s) => s.qrRevision);
  const crewAttentionAfterQr = useKundeStore((s) => s.crewAttentionAfterQr);
  const dialogKind = useUiStore((s) => s.dialogKind);
  const dialogVariant = useUiStore((s) => s.dialogVariant);
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
  const tmBlockedByVs = Boolean(kunde.videospringer.trim());
  const vsBlockedByTm = Boolean(kunde.tandemmaster.trim());
  const tandemmasterPinned = useMemo(() => {
    const pin = crewPinnedSelfOption(
      crewList,
      "tandemmaster",
      operatorName,
      { disabled: crewNamesEqual(operatorName, kunde.videospringer) },
    );
    return pin ? [pin] : [];
  }, [crewList, operatorName, kunde.videospringer]);
  const videospringerPinned = useMemo(() => {
    const pin = crewPinnedSelfOption(
      crewList,
      "videospringer",
      operatorName,
      { disabled: crewNamesEqual(operatorName, kunde.tandemmaster) },
    );
    return pin ? [pin] : [];
  }, [crewList, operatorName, kunde.tandemmaster]);
  const tmDisabledValues = useMemo(
    () => (tmBlockedByVs ? [kunde.videospringer.trim()] : []),
    [tmBlockedByVs, kunde.videospringer],
  );
  const vsDisabledValues = useMemo(
    () => (vsBlockedByTm ? [kunde.tandemmaster.trim()] : []),
    [vsBlockedByTm, kunde.tandemmaster],
  );
  const tmConflict =
    crewNamesEqual(kunde.tandemmaster, kunde.videospringer) &&
    Boolean(kunde.tandemmaster.trim());
  const vsConflict = tmConflict;
  const [nameLocked, setNameLocked] = useState(true);
  const crewSectionRef = useRef<HTMLDivElement>(null);
  const qrSuccessDialogWasOpen = useRef(false);

  const mode = (kunde.video_mode || "") as "" | "handcam" | "outside";
  const isQrMode = kunde.form_mode === "kunde";
  const busy = Boolean(disabled);
  // Crew is independent of import/QR locks; only freeze during Vorgang create unless overridden.
  const crewBusy = Boolean(crewDisabled ?? disabled);
  const modeToggleBusy = Boolean(modeToggleDisabled ?? disabled);
  const productsFromQr =
    isQrMode &&
    (kunde.handcam_foto ||
      kunde.handcam_video ||
      kunde.outside_foto ||
      kunde.outside_video);
  const productsLocked = productsFromQr && nameLocked;

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
      const state = useKundeStore.getState();
      if (state.crewAttentionAfterQr) {
        const videoMode = (state.kunde.video_mode || "") as
          | ""
          | "handcam"
          | "outside";
        const needsTm = !state.kunde.tandemmaster.trim();
        const needsVs =
          videoMode === "outside" && !state.kunde.videospringer.trim();
        if (needsTm || needsVs) {
          const focusId = needsTm ? CREW_TM_INPUT_ID : CREW_VS_INPUT_ID;
          // Wait for SuccessDialog unmount so focus is not stolen back.
          focusTimer = window.setTimeout(() => {
            crewSectionRef.current?.scrollIntoView({
              behavior: "smooth",
              block: "nearest",
            });
            document.getElementById(focusId)?.focus();
          }, 80);
        }
      }
    }
    qrSuccessDialogWasOpen.current = open;
    return () => {
      if (focusTimer !== undefined) window.clearTimeout(focusTimer);
    };
  }, [dialogKind, dialogVariant]);

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

  /** End QR crew dropdown workflow: blur so the list cannot reopen. */
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
    if (crewNamesEqual(v, useKundeStore.getState().kunde.videospringer)) {
      setField("tandemmaster", "");
      return;
    }
    if (focusVideospringerIfEmpty()) {
      finishCrewAttentionWorkflow(CREW_TM_INPUT_ID);
    }
  }

  function onVideospringerSelect(v: string) {
    if (crewNamesEqual(v, useKundeStore.getState().kunde.tandemmaster)) {
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
            Kunde
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
                {nameLocked ? "Bearbeiten" : "Sperren"}
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
                label="Vorname"
                value={kunde.vorname ?? ""}
                onChange={(v) => syncGastFromName(v, kunde.nachname ?? "")}
                disabled={busy || nameLocked}
              />
              <Field
                label="Nachname"
                value={kunde.nachname ?? ""}
                onChange={(v) => syncGastFromName(kunde.vorname ?? "", v)}
                disabled={busy || nameLocked}
              />
              <Field
                label="Kunden-ID Hash"
                value={kunde.kunden_id_hash ?? ""}
                onChange={(v) => setField("kunden_id_hash", v || null)}
                disabled={busy || nameLocked}
                mono
              />
              <Field
                label="Booking-ID Hash"
                value={kunde.booking_id_hash ?? ""}
                onChange={(v) => setField("booking_id_hash", v || null)}
                disabled={busy || nameLocked}
                mono
              />
            </>
          ) : (
            <>
              <Field
                label="Vorname"
                value={kunde.vorname ?? ""}
                onChange={(v) => syncGastFromName(v, kunde.nachname ?? "")}
                disabled={busy}
              />
              <Field
                label="Nachname"
                value={kunde.nachname ?? ""}
                onChange={(v) => syncGastFromName(kunde.vorname ?? "", v)}
                disabled={busy}
              />
              {oldschool ? (
                <>
                  <Field
                    label="E-Mail"
                    value={kunde.email ?? ""}
                    onChange={(v) => setField("email", v || null)}
                    disabled={busy}
                    type="email"
                  />
                  <Field
                    label="Telefon"
                    value={kunde.telefon ?? ""}
                    onChange={(v) => setField("telefon", v || null)}
                    disabled={busy}
                  />
                </>
              ) : null}
              {!nameEntry ? (
                <>
                  <Field
                    label="Kunden-ID"
                    value={kunde.kunden_id ?? ""}
                    onChange={(v) =>
                      setField("kunden_id", sanitizeNumericIdInput(v) || null)
                    }
                    disabled={busy}
                    mono
                    inputMode="numeric"
                    prefix={<Hash className="size-3.5 shrink-0" strokeWidth={2.25} />}
                  />
                  <Field
                    label="Booking-ID"
                    value={kunde.booking_id ?? ""}
                    onChange={(v) =>
                      setField("booking_id", sanitizeNumericIdInput(v) || null)
                    }
                    disabled={busy}
                    mono
                    inputMode="numeric"
                    prefix={<Hash className="size-3.5 shrink-0" strokeWidth={2.25} />}
                  />
                </>
              ) : null}
            </>
          )}
        </div>
      </section>
      <Section title="Crew">
        <div
          ref={crewSectionRef}
          className={cn(
            "grid gap-3",
            mode === "outside" ? "sm:grid-cols-2" : "sm:grid-cols-1",
          )}
        >
          <Combobox
            id={CREW_TM_INPUT_ID}
            label="Tandemmaster"
            value={kunde.tandemmaster}
            onChange={onTandemmasterChange}
            onSelectOption={onTandemmasterSelect}
            options={tandemmasterOptions}
            pinnedOptions={tandemmasterPinned}
            disabledValues={tmDisabledValues}
            disabled={crewBusy}
            placeholder="Name…"
            warning={warnTandemmaster}
            error={tmConflict ? CREW_ROLE_CONFLICT : undefined}
          />
          {mode === "outside" ? (
            <Combobox
              id={CREW_VS_INPUT_ID}
              label="Videospringer"
              value={kunde.videospringer}
              onChange={onVideospringerChange}
              onSelectOption={onVideospringerSelect}
              options={videospringerOptions}
              pinnedOptions={videospringerPinned}
              disabledValues={vsDisabledValues}
              disabled={crewBusy}
              placeholder="Name…"
              warning={warnVideospringer}
              error={vsConflict ? CREW_ROLE_CONFLICT : undefined}
            />
          ) : null}
        </div>
      </Section>

      <Section title="Medien">
        <div
          className={cn(
            "inline-flex w-full max-w-sm rounded-lg border border-border bg-card-elevated/80 p-1",
            (busy || productsLocked) && "opacity-60",
          )}
          role="group"
          aria-label="Medien-Modus"
        >
          {(
            [
              ["handcam", "Handcam"],
              ["outside", "Outside"],
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
            Handcam oder Outside wählen, um Produkte freizuschalten.
          </p>
        ) : null}

        {mode === "handcam" ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <MediaOptionCell
              label="Handcam Foto"
              checked={kunde.handcam_foto}
              paid={kunde.ist_bezahlt_handcam_foto}
              onChecked={(v) => setField("handcam_foto", v)}
              onPaid={(v) => setField("ist_bezahlt_handcam_foto", v)}
              disabled={busy || productsLocked}
            />
            <MediaOptionCell
              label="Handcam Video"
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
              label="Outside Foto"
              checked={kunde.outside_foto}
              paid={kunde.ist_bezahlt_outside_foto}
              onChecked={(v) => setField("outside_foto", v)}
              onPaid={(v) => setField("ist_bezahlt_outside_foto", v)}
              disabled={busy || productsLocked}
            />
            <MediaOptionCell
              label="Outside Video"
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
            Produkte aus dem QR sind gesperrt — „Bearbeiten“ zum Freigeben.
          </p>
        ) : null}
      </Section>
    </div>
  );
}

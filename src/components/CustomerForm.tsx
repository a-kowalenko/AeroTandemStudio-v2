import { useState, useEffect, useMemo, type InputHTMLAttributes, type ReactNode } from "react";
import { Eye, Hash, QrCode, UserRound, PencilLine } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { QrSpotlightPreview } from "@/components/QrSpotlightPreview";
import { useConfigStore } from "@/store/configStore";
import { useKundeStore } from "@/store/kundeStore";
import { syncProductsFromMedia } from "@/lib/syncProductsFromMedia";
import { ORT_OPTIONS, crewNamesForRole, normalizeManualEntryMode, withManualEntryMode, type ManualEntryMode } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { fileBaseName } from "@/lib/qrSuccess";

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

/** Convert stored DE `dd.mm.yyyy` (or ISO) → HTML date value `yyyy-mm-dd`. */
function datumToInputValue(datum: string): string {
  const raw = datum.trim();
  if (!raw) return "";
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) return raw;
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(raw);
  if (!de) return "";
  const dd = de[1].padStart(2, "0");
  const mm = de[2].padStart(2, "0");
  return `${de[3]}-${mm}-${dd}`;
}

/** HTML date value `yyyy-mm-dd` → DE `dd.mm.yyyy` (app storage / export). */
function inputValueToDatum(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return "";
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function DateField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted">{label}</Label>
      <Input
        type="date"
        value={datumToInputValue(value)}
        onChange={(e) => onChange(inputValueToDatum(e.target.value))}
        disabled={disabled}
        className={cn(
          "relative pr-9",
          "[&::-webkit-calendar-picker-indicator]:absolute",
          "[&::-webkit-calendar-picker-indicator]:right-2.5",
          "[&::-webkit-calendar-picker-indicator]:top-1/2",
          "[&::-webkit-calendar-picker-indicator]:h-4",
          "[&::-webkit-calendar-picker-indicator]:w-4",
          "[&::-webkit-calendar-picker-indicator]:-translate-y-1/2",
          "[&::-webkit-calendar-picker-indicator]:cursor-pointer",
          disabled && "bg-card-elevated",
        )}
      />
    </div>
  );
}

type ProductRowProps = {
  label: string;
  checked: boolean;
  paid: boolean;
  onChecked: (v: boolean) => void;
  onPaid: (v: boolean) => void;
  disabled?: boolean;
};

function ProductRow({ label, checked, paid, onChecked, onPaid, disabled }: ProductRowProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors",
        checked
          ? "border-primary/35 bg-primary-soft/40"
          : "border-border bg-card-elevated/80",
      )}
    >
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => {
            const on = v === true;
            onChecked(on);
            if (!on) onPaid(false);
          }}
          disabled={disabled}
        />
        {label}
      </label>
      <label className="flex items-center gap-2 text-xs text-muted">
        <Checkbox
          checked={paid}
          onCheckedChange={(v) => {
            const on = v === true;
            onPaid(on);
            if (on) onChecked(true);
          }}
          disabled={disabled}
        />
        Bezahlt
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

/** Dropzone / Datum — above Kunde in the form (scrolls with content). */
function CustomerSessionSection({ disabled }: CustomerFormProps) {
  const kunde = useKundeStore((s) => s.kunde);
  const setField = useKundeStore((s) => s.setField);
  const busy = Boolean(disabled);

  return (
    <Section title="Session">
      <div className="grid gap-3 sm:grid-cols-2">
        <Combobox
          label="Dropzone"
          value={kunde.ort}
          onChange={(v) => setField("ort", v)}
          options={ORT_OPTIONS}
          disabled={busy}
          placeholder="Dropzone…"
        />
        <DateField
          label="Datum"
          value={kunde.datum}
          onChange={(v) => setField("datum", v)}
          disabled={busy}
        />
      </div>
    </Section>
  );
}

/** Compact QR ↔ Manuell toggle + optional Scan-Frame viewer. */
export function CustomerFormToolbar({ disabled }: CustomerFormProps) {
  const formMode = useKundeStore((s) => s.kunde.form_mode);
  const qrSnapshot = useKundeStore((s) => s.qrSnapshot);
  const qrPreview = useKundeStore((s) => s.qrPreview);
  const qrPreviewSource = useKundeStore((s) => s.qrPreviewSource);
  const switchFormMode = useKundeStore((s) => s.switchFormMode);
  const busy = Boolean(disabled);
  const isQrMode = formMode === "kunde";
  const canSwitchToQr = Boolean(qrSnapshot);
  const [scanOpen, setScanOpen] = useState(false);
  const [showShadow, setShowShadow] = useState(true);
  const hasPreview = Boolean(qrPreview?.path?.trim());
  const sourceLabel = fileBaseName(qrPreviewSource);

  useEffect(() => {
    if (!hasPreview && scanOpen) setScanOpen(false);
  }, [hasPreview, scanOpen]);

  return (
    <div className="inline-flex shrink-0 items-center gap-1.5">
      {hasPreview && qrPreview ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-[11px]"
            disabled={busy}
            title="QR-Scan-Frame anzeigen"
            onClick={() => {
              setShowShadow(true);
              setScanOpen(true);
            }}
          >
            <Eye className="h-3 w-3" />
            Scan
          </Button>
          <Dialog open={scanOpen} onOpenChange={setScanOpen}>
            <DialogContent className="max-w-lg gap-4">
              <DialogHeader>
                <DialogTitle>QR-Scan</DialogTitle>
                <DialogDescription>
                  {sourceLabel
                    ? `Treffer-Frame aus ${sourceLabel}`
                    : "Treffer-Frame aus dieser Session"}
                </DialogDescription>
              </DialogHeader>
              <QrSpotlightPreview
                preview={qrPreview}
                showSpotlight={showShadow}
                className="w-full"
              />
              <label
                htmlFor="qr-scan-shadow"
                className="mx-auto flex w-fit cursor-pointer items-center gap-2.5 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
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
              <DialogFooter>
                <Button type="button" onClick={() => setScanOpen(false)}>
                  Schließen
                </Button>
              </DialogFooter>
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

export function CustomerForm({ disabled }: CustomerFormProps) {
  const kunde = useKundeStore((s) => s.kunde);
  const setField = useKundeStore((s) => s.setField);
  const patch = useKundeStore((s) => s.patch);
  const setVideoMode = useKundeStore((s) => s.setVideoMode);
  const qrRevision = useKundeStore((s) => s.qrRevision);
  const config = useConfigStore((s) => s.config);
  const entryMode = normalizeManualEntryMode(
    config?.manual_entry_mode,
    config?.oldschool_mode ?? false,
  );
  const nameEntry = entryMode === "oldschool" || entryMode === "lokal";
  const oldschool = entryMode === "oldschool";
  const crewList = config?.crew_list;
  const tandemmasterOptions = useMemo(
    () => crewNamesForRole(crewList, "tandemmaster"),
    [crewList],
  );
  const videospringerOptions = useMemo(
    () => crewNamesForRole(crewList, "videospringer"),
    [crewList],
  );
  const [nameLocked, setNameLocked] = useState(true);

  const mode = (kunde.video_mode || "") as "" | "handcam" | "outside";
  const isQrMode = kunde.form_mode === "kunde";
  const busy = Boolean(disabled);
  const productsFromQr =
    isQrMode &&
    (kunde.handcam_foto ||
      kunde.handcam_video ||
      kunde.outside_foto ||
      kunde.outside_video);
  const productsLocked = productsFromQr && nameLocked;

  // Re-lock after QR apply (including Auto-QR / Medienliste / Vorschau).
  useEffect(() => {
    if (qrRevision > 0) setNameLocked(true);
  }, [qrRevision]);

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
      <CustomerSessionSection disabled={busy} />

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
            <CustomerFormToolbar disabled={busy} />
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
          className={cn(
            "grid gap-3",
            mode === "outside" ? "sm:grid-cols-2" : "sm:grid-cols-1",
          )}
        >
          <Combobox
            label="Tandemmaster"
            value={kunde.tandemmaster}
            onChange={(v) => setField("tandemmaster", v)}
            options={tandemmasterOptions}
            disabled={busy}
            placeholder="Name…"
          />
          {mode === "outside" ? (
            <Combobox
              label="Videospringer"
              value={kunde.videospringer}
              onChange={(v) => setField("videospringer", v)}
              options={videospringerOptions}
              disabled={busy}
              placeholder="Name…"
            />
          ) : null}
        </div>
      </Section>

      <Section title="Medien-Modus">
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

        {mode === "handcam" && (
          <div className="mt-2 space-y-2">
            <ProductRow
              label="Handcam Foto"
              checked={kunde.handcam_foto}
              paid={kunde.ist_bezahlt_handcam_foto}
              onChecked={(v) => setField("handcam_foto", v)}
              onPaid={(v) => setField("ist_bezahlt_handcam_foto", v)}
              disabled={busy || productsLocked}
            />
            <ProductRow
              label="Handcam Video"
              checked={kunde.handcam_video}
              paid={kunde.ist_bezahlt_handcam_video}
              onChecked={(v) => setField("handcam_video", v)}
              onPaid={(v) => setField("ist_bezahlt_handcam_video", v)}
              disabled={busy || productsLocked}
            />
          </div>
        )}

        {mode === "outside" && (
          <div className="mt-2 space-y-2">
            <ProductRow
              label="Outside Foto"
              checked={kunde.outside_foto}
              paid={kunde.ist_bezahlt_outside_foto}
              onChecked={(v) => setField("outside_foto", v)}
              onPaid={(v) => setField("ist_bezahlt_outside_foto", v)}
              disabled={busy || productsLocked}
            />
            <ProductRow
              label="Outside Video"
              checked={kunde.outside_video}
              paid={kunde.ist_bezahlt_outside_video}
              onChecked={(v) => setField("outside_video", v)}
              onPaid={(v) => setField("ist_bezahlt_outside_video", v)}
              disabled={busy || productsLocked}
            />
          </div>
        )}

        {productsLocked ? (
          <p className="text-[11px] text-muted">
            Produkte aus dem QR sind gesperrt — „Bearbeiten“ zum Freigeben.
          </p>
        ) : null}
      </Section>
    </div>
  );
}

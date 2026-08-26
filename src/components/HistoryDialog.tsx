import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Eye } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Checkbox } from "./ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import {
  deleteProcessedFiles,
  listProcessedFiles,
  purgeProcessedFiles,
  type ProcessedFileEntry,
} from "../lib/sdCard";
import {
  deleteVorgaenge,
  getHandoffStatus,
  listVorgangDateien,
  listVorgaenge,
  listVorgangAppends,
  preflightVorgangUpload,
  resyncVorgangDeliveryList,
  canRetryVorgangUpload,
  pendingUploadCandidates,
  type AppendMediaItem,
  type HandoffStatus,
  type UploadPreflightIssue,
  type VorgangAppendEntry,
  type VorgangEntry,
  type VorgangFileEntry,
  type VorgangUploadRetryOptions,
} from "../lib/vorgangHistory";
import { useConfigStore } from "@/store/configStore";
import { useServerStore } from "@/store/serverStore";
import {
  UploadExtraFilesConfirmDialog,
  type UploadExtraFilesConfirmChoice,
} from "@/components/UploadExtraFilesConfirmDialog";
import { UploadPreflightHardFailDialog } from "@/components/UploadPreflightHardFailDialog";
import { UploadMissingFilesDialog } from "@/components/UploadMissingFilesDialog";
import {
  UploadPartialConfirmDialog,
  type UploadPartialConfirmChoice,
} from "@/components/UploadPartialConfirmDialog";
import type {
  UploadExtraFilesConfirmState,
  UploadMissingFilesState,
  UploadPartialConfirmState,
  UploadPreflightHardFailState,
} from "@/lib/uploadPreflight";
import {
  canOfferPartialUpload,
  missingFilePathsFromPreflight,
} from "@/lib/uploadPreflight";
import {
  isAmsCancelled,
  isAmsHandoffSettled,
  matchesAmsStatusFilter,
  viewFromAppendEntry,
  viewFromAppendRecord,
  viewFromHandoffStatus,
  viewFromVorgangEntry,
  type AmsStatusFilter,
} from "../lib/amsHandoffStatus";
import {
  AppendMediaPanel,
  type AppendMediaPanelHandle,
} from "@/components/AppendMediaDialog";
import { useAppendStore } from "@/store/appendStore";
import { useHistoryStore } from "@/store/historyStore";
import { useUiStore } from "@/store/uiStore";
import { presentAmsUserMessage } from "@/lib/amsBridgeStatus";
import { tr } from "@/i18n";
import { formatLocaleDateTime } from "@/lib/locale";
import { cn, isCancellationError } from "@/lib/utils";
import {
  AmsHandoffStatusChip,
  AmsHandoffStepper,
} from "@/components/AmsHandoffStatus";
import { QrHitMeta } from "@/components/QrHitMeta";
import {
  QR_PREVIEW_FRAME_AR,
  QrSpotlightPreview,
} from "@/components/QrSpotlightPreview";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After preflight OK (and soft-ack if needed): run SMB upload with Create progress UX. */
  onRetryUpload?: (entry: VorgangEntry, opts?: VorgangUploadRetryOptions) => void;
  /** Sequentially retry all ready pending/failed uploads (Phase 31.3). */
  onBulkRetryUploads?: (entries: VorgangEntry[]) => void;
};

type TypeFilter = "all" | "video" | "photo";
type PeriodFilter = "all" | "today" | "7d" | "30d" | "365d";

const AMS_STATUS_FILTERS: AmsStatusFilter[] = ["all", "open", "done", "error"];

type PendingConfirm = {
  title: string;
  description: string;
  actionLabel: string;
  /** Default: destructive (delete). Bulk upload uses default. */
  actionVariant?: "destructive" | "default";
  run: () => Promise<void>;
};

function formatBytes(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * History rows were stored as UTC wall clock without a timezone marker.
 * Treat missing offset/Z as UTC so display and filters match local time.
 */
function parseHistoryIso(iso: string): number {
  const s = iso.trim();
  if (!s) return Number.NaN;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  return Date.parse(hasZone ? s : `${s}Z`);
}

function withinPeriod(iso: string | null, period: PeriodFilter): boolean {
  if (period === "all" || !iso) return period === "all";
  const t = parseHistoryIso(iso);
  if (Number.isNaN(t)) return false;
  const now = Date.now();
  const day = 86400000;
  if (period === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return t >= d.getTime();
  }
  if (period === "7d") return now - t <= 7 * day;
  if (period === "30d") return now - t <= 30 * day;
  if (period === "365d") return now - t <= 365 * day;
  return true;
}

type ProductBadge = { key: string; label: string; paid: boolean };

function productBadges(v: VorgangEntry): ProductBadge[] {
  const badges: ProductBadge[] = [];
  if (v.handcam_video) {
    badges.push({
      key: "hv",
      label: "HV",
      paid: Boolean(v.ist_bezahlt_handcam_video),
    });
  }
  if (v.handcam_foto) {
    badges.push({
      key: "hf",
      label: "HF",
      paid: Boolean(v.ist_bezahlt_handcam_foto),
    });
  }
  if (v.outside_video) {
    badges.push({
      key: "ov",
      label: "OV",
      paid: Boolean(v.ist_bezahlt_outside_video),
    });
  }
  if (v.outside_foto) {
    badges.push({
      key: "of",
      label: "OF",
      paid: Boolean(v.ist_bezahlt_outside_foto),
    });
  }
  return badges;
}

function ProductStatusChip({ badge }: { badge: ProductBadge }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none",
        badge.paid
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100"
          : "border-border/60 bg-muted/30 text-muted-foreground",
      )}
      title={badge.paid ? t("history.paidTitle", { label: badge.label }) : badge.label}
    >
      {badge.label}
      {badge.paid ? (
        <Check className="size-2.5 shrink-0" strokeWidth={2.5} aria-hidden />
      ) : null}
    </span>
  );
}

/** SMB upload chip (Phase 31.1); retry action in detail panel (31.2). */
function UploadStateChip({ state }: { state: string }) {
  const { t } = useTranslation();
  const s = state.trim().toLowerCase();
  if (s !== "pending" && s !== "failed" && s !== "uploading") return null;
  const label =
    s === "failed"
      ? t("history.upload.failed")
      : s === "uploading"
        ? t("history.upload.uploading")
        : t("history.upload.pending");
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center truncate rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none",
        s === "failed"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : s === "uploading"
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-warning/40 bg-warning/10 text-warning",
      )}
      title={label}
    >
      {label}
    </span>
  );
}

function applyHandoffToEntry(entry: VorgangEntry, status: HandoffStatus): VorgangEntry {
  return {
    ...entry,
    ams_state: status.state,
    ams_updated_at: status.updated_at || entry.ams_updated_at,
    ams_error_code: status.error?.code ?? "",
    ams_error_message: status.error?.message ?? "",
    ams_archive: status.ams.archive ?? "",
    ams_source: status.source ?? entry.ams_source,
  };
}

function applyAppendStatusToEntry(
  entry: VorgangEntry,
  status: HandoffStatus,
): VorgangEntry {
  if (entry.last_append_correlation_id.trim() !== status.correlation_id.trim()) {
    return entry;
  }
  return {
    ...entry,
    last_append_ams_state: status.state,
    last_append_ams_error_code: status.error?.code ?? "",
    last_append_ams_error_message: status.error?.message ?? "",
  };
}

function appendHandoffStatusFromRecord(
  record: VorgangAppendEntry,
): HandoffStatus | null {
  const view = viewFromAppendRecord(record);
  if (!view) return null;
  return {
    correlation_id: record.correlation_id,
    state: view.state,
    updated_at: record.ams_updated_at,
    error: view.errorCode
      ? { code: view.errorCode, message: view.errorMessage ?? "" }
      : null,
    ams: { history_id: null, archive: null },
    source: "cached",
    offline: false,
  };
}

function applyAppendStatusToRecord(
  record: VorgangAppendEntry,
  status: HandoffStatus,
): VorgangAppendEntry {
  if (record.correlation_id.trim() !== status.correlation_id.trim()) {
    return record;
  }
  return {
    ...record,
    ams_state: status.state,
    ams_updated_at: status.updated_at || record.ams_updated_at,
    ams_error_code: status.error?.code ?? "",
    ams_error_message: status.error?.message ?? "",
  };
}

function appendHandoffStatusFromEntry(entry: VorgangEntry): HandoffStatus | null {
  const cid = entry.last_append_correlation_id?.trim() ?? "";
  const view = viewFromAppendEntry(entry);
  if (!cid || !view) return null;
  return {
    correlation_id: cid,
    state: view.state,
    updated_at: "",
    error: view.errorCode
      ? { code: view.errorCode, message: view.errorMessage ?? "" }
      : null,
    ams: { history_id: null, archive: null },
    source: "cached",
    offline: false,
  };
}

function roleLabel(role: string): string {
  switch (role) {
    case "source_video":
      return tr("history.role.sourceVideo");
    case "source_photo":
      return tr("history.role.sourcePhoto");
    case "output_video":
      return tr("history.role.outputVideo");
    case "wm_video":
      return tr("history.role.wmVideo");
    case "marker":
      return tr("history.role.marker");
    case "append_handcam_video":
      return tr("history.role.appendHandcamVideo");
    case "append_outside_video":
      return tr("history.role.appendOutsideVideo");
    case "append_handcam_foto":
      return tr("history.role.appendHandcamFoto");
    case "append_outside_foto":
      return tr("history.role.appendOutsideFoto");
    case "append_preview_video":
      return tr("history.role.appendPreviewVideo");
    case "append_preview_foto":
      return tr("history.role.appendPreviewFoto");
    default:
      return role;
  }
}

function formatCreatedAt(iso: string): string {
  const parsed = parseHistoryIso(iso);
  if (Number.isNaN(parsed)) return iso;
  return formatLocaleDateTime(parsed);
}

function entryModeLabel(formMode: string, manualEntryMode: string): string | null {
  const form = formMode.trim().toLowerCase();
  if (form === "kunde") return tr("history.mode.qr");
  if (form !== "manual") {
    return form ? formMode.trim() : null;
  }
  switch (manualEntryMode.trim().toLowerCase()) {
    case "id":
      return tr("history.mode.manualId");
    case "oldschool":
      return tr("history.mode.manualContact");
    case "lokal":
      return tr("history.mode.manualLocal");
    default:
      return tr("history.mode.manual");
  }
}

/** @deprecated Prefer HistoryDialog — kept for existing imports. */
export function ProcessedFilesDialog(props: Props) {
  return <HistoryDialog {...props} />;
}

export function HistoryDialog({
  open,
  onOpenChange,
  onRetryUpload = () => {},
  onBulkRetryUploads = () => {},
}: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"vorgaenge" | "medien">("vorgaenge");
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [qrScanOpen, setQrScanOpen] = useState(false);
  const [appendVorgang, setAppendVorgang] = useState<VorgangEntry | null>(null);
  const [appendPickingFiles, setAppendPickingFiles] = useState(false);
  const [appendRefreshKey, setAppendRefreshKey] = useState(0);
  const appendPanelRef = useRef<AppendMediaPanelHandle>(null);
  const runAppendJob = useAppendStore((s) => s.runJob);
  const showError = useUiStore((s) => s.showError);
  const showWarning = useUiStore((s) => s.showWarning);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const [extraFilesConfirm, setExtraFilesConfirm] =
    useState<UploadExtraFilesConfirmState | null>(null);
  const [preflightHardFail, setPreflightHardFail] =
    useState<UploadPreflightHardFailState | null>(null);
  const [missingFilesConfirm, setMissingFilesConfirm] =
    useState<UploadMissingFilesState | null>(null);
  const [partialUploadConfirm, setPartialUploadConfirm] =
    useState<UploadPartialConfirmState | null>(null);
  const pendingRetryEntryRef = useRef<VorgangEntry | null>(null);
  const pendingOmittedCountRef = useRef(0);
  const [retryPreflightBusy, setRetryPreflightBusy] = useState(false);
  const appendOpen = appendVorgang != null;
  const confirmOpen = pendingConfirm != null;
  const nestedOpen =
    confirmOpen ||
    qrScanOpen ||
    appendOpen ||
    appendPickingFiles ||
    extraFilesConfirm != null ||
    preflightHardFail != null ||
    missingFilesConfirm != null ||
    partialUploadConfirm != null;

  const closeAppendView = useCallback(() => {
    setAppendVorgang(null);
    setAppendPickingFiles(false);
  }, []);

  const startRetryUpload = useCallback(
    (entry: VorgangEntry, opts?: VorgangUploadRetryOptions) => {
      pendingRetryEntryRef.current = null;
      pendingOmittedCountRef.current = 0;
      setExtraFilesConfirm(null);
      setPreflightHardFail(null);
      setMissingFilesConfirm(null);
      setPartialUploadConfirm(null);
      onOpenChange(false);
      onRetryUpload(entry, opts);
    },
    [onOpenChange, onRetryUpload],
  );

  const startBulkRetryUploads = useCallback(
    (entries: VorgangEntry[]) => {
      if (entries.length === 0) return;
      setExtraFilesConfirm(null);
      setPreflightHardFail(null);
      setMissingFilesConfirm(null);
      setPartialUploadConfirm(null);
      onOpenChange(false);
      onBulkRetryUploads(entries);
    },
    [onOpenChange, onBulkRetryUploads],
  );

  async function handleRequestRetryUpload(entry: VorgangEntry) {
    if (retryPreflightBusy) return;
    setRetryPreflightBusy(true);
    try {
      const result = await preflightVorgangUpload(entry.id);
      if (!result.ok || result.hard_errors.length > 0) {
        if (canOfferPartialUpload(result.hard_errors)) {
          pendingRetryEntryRef.current = entry;
          const missingPaths = missingFilePathsFromPreflight(result.hard_errors);
          setMissingFilesConfirm({
            guest: entry.gast,
            folderPath: entry.base_output_dir,
            missingPaths,
          });
          return;
        }
        setPreflightHardFail({
          guest: entry.gast,
          issues: result.hard_errors,
        });
        return;
      }
      const extras = result.soft_warnings
        .filter((w) => w.code === "extra_file")
        .map((w) => w.path)
        .filter(Boolean);
      if (extras.length > 0) {
        pendingRetryEntryRef.current = entry;
        setExtraFilesConfirm({
          vorgangId: entry.id,
          guest: entry.gast,
          extraPaths: extras,
        });
        return;
      }
      startRetryUpload(entry);
    } catch (e) {
      showError(String(e), t("history.upload.retryTitle"));
    } finally {
      setRetryPreflightBusy(false);
    }
  }

  function onExtraFilesChoice(choice: UploadExtraFilesConfirmChoice) {
    const entry = pendingRetryEntryRef.current;
    const omitted = pendingOmittedCountRef.current;
    setExtraFilesConfirm(null);
    pendingOmittedCountRef.current = 0;
    if (choice !== "proceed" || !entry) {
      pendingRetryEntryRef.current = null;
      return;
    }
    startRetryUpload(entry, omitted > 0 ? { omittedFileCount: omitted } : undefined);
  }

  function onMissingFilesUploadAvailable() {
    const entry = pendingRetryEntryRef.current;
    if (!entry || !missingFilesConfirm) return;
    setPartialUploadConfirm({
      guest: entry.gast,
      missingPaths: missingFilesConfirm.missingPaths,
    });
  }

  async function onPartialUploadChoice(choice: UploadPartialConfirmChoice) {
    const entry = pendingRetryEntryRef.current;
    const missingPaths = partialUploadConfirm?.missingPaths ?? [];
    setPartialUploadConfirm(null);
    if (choice !== "proceed" || !entry) {
      return;
    }
    setRetryPreflightBusy(true);
    try {
      const report = await resyncVorgangDeliveryList(entry.id);
      const omitted = report.removed_paths.length;
      const pf = await preflightVorgangUpload(entry.id);
      if (!pf.ok || pf.hard_errors.length > 0) {
        if (canOfferPartialUpload(pf.hard_errors)) {
          pendingRetryEntryRef.current = entry;
          setMissingFilesConfirm({
            guest: entry.gast,
            folderPath: entry.base_output_dir,
            missingPaths: missingFilePathsFromPreflight(pf.hard_errors),
          });
        } else {
          setMissingFilesConfirm(null);
          setPreflightHardFail({
            guest: entry.gast,
            issues: pf.hard_errors,
          });
        }
        return;
      }
      const extras = pf.soft_warnings
        .filter((w) => w.code === "extra_file")
        .map((w) => w.path)
        .filter(Boolean);
      if (extras.length > 0) {
        pendingRetryEntryRef.current = entry;
        pendingOmittedCountRef.current = omitted;
        setMissingFilesConfirm(null);
        setExtraFilesConfirm({
          vorgangId: entry.id,
          guest: entry.gast,
          extraPaths: extras,
        });
        return;
      }
      setMissingFilesConfirm(null);
      startRetryUpload(entry, {
        omittedFileCount: omitted > 0 ? omitted : missingPaths.length,
      });
    } catch (e) {
      showError(String(e), t("history.upload.retryTitle"));
    } finally {
      setRetryPreflightBusy(false);
    }
  }

  async function runConfirm() {
    if (!pendingConfirm || confirmBusy) return;
    setConfirmBusy(true);
    try {
      await pendingConfirm.run();
      setPendingConfirm(null);
    } finally {
      setConfirmBusy(false);
    }
  }

  async function handleAppendSubmit(items: AppendMediaItem[]) {
    if (!appendVorgang) return;
    const vorgang = appendVorgang;
    closeAppendView();
    onOpenChange(false);
    try {
      const res = await runAppendJob(vorgang.id, items, {
        vorgangId: vorgang.id,
        guest: vorgang.gast,
        fileCount: items.length,
      });
      showSuccess(
        t("history.appendSuccess", {
          count: res.file_count,
          folder: res.folder_name,
        }),
        t("history.appendDialogTitle"),
        { autoCloseSecs: 8 },
      );
      setAppendRefreshKey((k) => k + 1);
    } catch (e) {
      if (isCancellationError(e)) {
        showWarning(t("history.appendCancelled"), t("history.appendDialogTitle"));
      } else {
        showError(presentAmsUserMessage(String(e)), t("history.appendDialogTitle"));
      }
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) {
            if (appendOpen) {
              appendPanelRef.current?.requestBack();
              return;
            }
            setPendingConfirm(null);
            setQrScanOpen(false);
            setExtraFilesConfirm(null);
            setPreflightHardFail(null);
            pendingRetryEntryRef.current = null;
            closeAppendView();
          }
          onOpenChange(v);
        }}
      >
        <DialogContent
          hideCloseButton={appendOpen}
          className="relative !flex h-[min(88vh,720px)] w-[min(1100px,96vw)] max-w-none flex-col gap-0 overflow-hidden p-0"
          onPointerDownOutside={(e) => {
            if (nestedOpen) e.preventDefault();
          }}
          onFocusOutside={(e) => {
            if (nestedOpen) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (nestedOpen) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (appendPickingFiles) {
              e.preventDefault();
              return;
            }
            if (
              confirmOpen ||
              qrScanOpen ||
              extraFilesConfirm != null ||
              preflightHardFail != null
            ) {
              e.preventDefault();
              return;
            }
            if (appendOpen) {
              e.preventDefault();
              appendPanelRef.current?.requestBack();
            }
          }}
        >
          <DialogTitle className="sr-only">
            {appendOpen && appendVorgang
              ? t("history.appendTitle", { guest: appendVorgang.gast })
              : t("history.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {appendOpen
              ? t("history.appendDescription")
              : t("history.description")}
          </DialogDescription>

          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col gap-3 p-6 transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
              appendOpen && "pointer-events-none -translate-x-6 opacity-0",
            )}
            aria-hidden={appendOpen}
          >
            <DialogHeader className="shrink-0 pr-8">
              <div className="text-lg font-semibold leading-none tracking-tight">
                {t("history.title")}
              </div>
              <p className="text-sm text-muted">
                {t("history.description")}
              </p>
            </DialogHeader>

            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as "vorgaenge" | "medien")}
              className="flex min-h-0 flex-1 flex-col gap-3"
            >
              <TabsList className="h-9 w-fit shrink-0">
                <TabsTrigger value="vorgaenge" className="text-xs">
                  {t("history.tabs.jobs")}
                </TabsTrigger>
                <TabsTrigger value="medien" className="text-xs">
                  {t("history.tabs.media")}
                </TabsTrigger>
              </TabsList>

              <div className="relative min-h-0 flex-1">
                <TabsContent
                  value="vorgaenge"
                  forceMount
                  className="absolute inset-0 mt-0 flex flex-col data-[state=inactive]:pointer-events-none data-[state=inactive]:invisible data-[state=inactive]:opacity-0"
                >
                  <VorgaengePanel
                    dialogOpen={open}
                    qrScanOpen={qrScanOpen}
                    onQrScanOpenChange={setQrScanOpen}
                    appendRefreshKey={appendRefreshKey}
                    onOpenAppend={setAppendVorgang}
                    onRequestConfirm={setPendingConfirm}
                    onRequestRetryUpload={(entry) =>
                      void handleRequestRetryUpload(entry)
                    }
                    onStartBulkRetry={startBulkRetryUploads}
                    retryPreflightBusy={retryPreflightBusy}
                  />
                </TabsContent>
                <TabsContent
                  value="medien"
                  className="absolute inset-0 mt-0 flex flex-col data-[state=inactive]:pointer-events-none data-[state=inactive]:invisible data-[state=inactive]:opacity-0"
                >
                  <MedienPanel
                    dialogOpen={open}
                    onRequestConfirm={setPendingConfirm}
                  />
                </TabsContent>
              </div>
            </Tabs>

            <DialogFooter className="shrink-0">
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t("common.actions.close")}
              </Button>
            </DialogFooter>
          </div>

          <div
            className={cn(
              "absolute inset-0 z-20 flex flex-col overflow-hidden bg-card transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
              appendOpen
                ? "translate-x-0"
                : "pointer-events-none translate-x-full",
            )}
            aria-hidden={!appendOpen}
          >
            {appendVorgang ? (
              <AppendMediaPanel
                ref={appendPanelRef}
                vorgang={appendVorgang}
                onBack={closeAppendView}
                onPickingFilesChange={setAppendPickingFiles}
                onSubmit={(items) => void handleAppendSubmit(items)}
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmOpen}
        onOpenChange={(v) => {
          if (!v && !confirmBusy) setPendingConfirm(null);
        }}
      >
        <DialogContent
          className={cn(
            "z-[60] max-w-md border-l-4",
            (pendingConfirm?.actionVariant ?? "destructive") === "destructive"
              ? "border-l-destructive"
              : "border-l-primary",
          )}
          overlayClassName="z-[60]"
        >
          <DialogHeader>
            <DialogTitle
              className={
                (pendingConfirm?.actionVariant ?? "destructive") ===
                "destructive"
                  ? "text-destructive"
                  : undefined
              }
            >
              {pendingConfirm?.title}
            </DialogTitle>
            <DialogDescription className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-foreground">
              {pendingConfirm?.description}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="secondary"
              disabled={confirmBusy}
              onClick={() => setPendingConfirm(null)}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              type="button"
              variant={pendingConfirm?.actionVariant ?? "destructive"}
              disabled={confirmBusy}
              onClick={() => void runConfirm()}
            >
              {pendingConfirm?.actionLabel ?? t("common.actions.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UploadExtraFilesConfirmDialog
        open={extraFilesConfirm != null}
        guest={extraFilesConfirm?.guest ?? ""}
        extraPaths={extraFilesConfirm?.extraPaths ?? []}
        onChoose={onExtraFilesChoice}
      />
      <UploadPreflightHardFailDialog
        open={preflightHardFail != null}
        guest={preflightHardFail?.guest ?? ""}
        issues={(preflightHardFail?.issues ?? []) as UploadPreflightIssue[]}
        onClose={() => setPreflightHardFail(null)}
      />
      <UploadMissingFilesDialog
        open={missingFilesConfirm != null}
        guest={missingFilesConfirm?.guest ?? ""}
        folderPath={missingFilesConfirm?.folderPath ?? ""}
        missingPaths={missingFilesConfirm?.missingPaths ?? []}
        onUploadAvailable={onMissingFilesUploadAvailable}
        onClose={() => {
          pendingRetryEntryRef.current = null;
          setMissingFilesConfirm(null);
        }}
      />
      <UploadPartialConfirmDialog
        open={partialUploadConfirm != null}
        guest={partialUploadConfirm?.guest ?? ""}
        missingPaths={partialUploadConfirm?.missingPaths ?? []}
        onChoose={onPartialUploadChoice}
      />
    </>
  );
}

function seedVorgaengePanel(): {
  entries: VorgangEntry[];
  selectedId: number | null;
  ready: boolean;
  files: VorgangFileEntry[];
  filesReady: boolean;
  appends: VorgangAppendEntry[];
  appendsReady: boolean;
} {
  const s = useHistoryStore.getState();
  const entries = s.vorgaengeLoaded ? s.vorgaenge : [];
  const selectedId =
    s.selectedId != null && entries.some((r) => r.id === s.selectedId)
      ? s.selectedId
      : (entries[0]?.id ?? null);
  const filesHit = selectedId != null && s.filesVorgangId === selectedId;
  const appendsHit = selectedId != null && s.appendsVorgangId === selectedId;
  return {
    entries,
    selectedId,
    ready: s.vorgaengeLoaded,
    files: filesHit ? s.files : [],
    filesReady: selectedId == null || filesHit,
    appends: appendsHit ? s.appends : [],
    appendsReady: selectedId == null || appendsHit,
  };
}

function VorgaengePanel({
  dialogOpen,
  qrScanOpen,
  onQrScanOpenChange,
  appendRefreshKey,
  onOpenAppend,
  onRequestConfirm,
  onRequestRetryUpload,
  onStartBulkRetry,
  retryPreflightBusy,
}: {
  dialogOpen: boolean;
  qrScanOpen: boolean;
  onQrScanOpenChange: (open: boolean) => void;
  appendRefreshKey: number;
  onOpenAppend: (vorgang: VorgangEntry) => void;
  onRequestConfirm: (pending: PendingConfirm) => void;
  onRequestRetryUpload: (entry: VorgangEntry) => void;
  onStartBulkRetry: (entries: VorgangEntry[]) => void;
  retryPreflightBusy: boolean;
}) {
  const { t } = useTranslation();
  const uploadToServer = useConfigStore((s) =>
    Boolean(s.config?.upload_to_server),
  );
  const serverConnected = useServerStore((s) => s.connected);
  const showWarning = useUiStore((s) => s.showWarning);
  const [entries, setEntries] = useState<VorgangEntry[]>(
    () => seedVorgaengePanel().entries,
  );
  const [search, setSearch] = useState("");
  const [amsFilter, setAmsFilter] = useState<AmsStatusFilter>("all");
  const [selectedId, setSelectedId] = useState<number | null>(
    () => seedVorgaengePanel().selectedId,
  );
  const [files, setFiles] = useState<VorgangFileEntry[]>(
    () => seedVorgaengePanel().files,
  );
  const [loading, setLoading] = useState(() => !seedVorgaengePanel().ready);
  const [ready, setReady] = useState(() => seedVorgaengePanel().ready);
  const [filesReady, setFilesReady] = useState(
    () => seedVorgaengePanel().filesReady,
  );
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [showShadow, setShowShadow] = useState(true);
  const [handoffStatus, setHandoffStatus] = useState<HandoffStatus | null>(null);
  const [handoffReady, setHandoffReady] = useState(false);
  const [appendStatus, setAppendStatus] = useState<HandoffStatus | null>(null);
  const [appends, setAppends] = useState<VorgangAppendEntry[]>(
    () => seedVorgaengePanel().appends,
  );
  const [appendsReady, setAppendsReady] = useState(
    () => seedVorgaengePanel().appendsReady,
  );
  const searchRef = useRef(search);
  searchRef.current = search;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const searchSkipRef = useRef(true);
  const appendJobActive = useAppendStore((s) => s.active);

  function patchEntry(id: number, fn: (row: VorgangEntry) => VorgangEntry) {
    setEntries((prev) => prev.map((e) => (e.id === id ? fn(e) : e)));
    useHistoryStore.getState().patchVorgang(id, fn);
  }

  async function reload(q?: string, opts?: { silent?: boolean }) {
    const query = q?.trim() || "";
    const silent =
      Boolean(opts?.silent) && entriesRef.current.length > 0 && !query;
    if (!silent) setLoading(true);
    try {
      const rows = await listVorgaenge(500, query || undefined);
      setEntries(rows);
      if (!query) {
        useHistoryStore.getState().setVorgaenge(rows);
      }
      if (!silent) setChecked(new Set());
      setSelectedId((prev) => {
        const next =
          prev != null && rows.some((r) => r.id === prev)
            ? prev
            : (rows[0]?.id ?? null);
        useHistoryStore.getState().setSelectedId(next);
        return next;
      });
    } catch {
      if (!silent) {
        setEntries([]);
        setSelectedId(null);
      }
    } finally {
      setLoading(false);
      setReady(true);
    }
  }

  useEffect(() => {
    if (!dialogOpen) return;
    const cached = useHistoryStore.getState().vorgaengeLoaded;
    void reload(searchRef.current, {
      silent: cached && !searchRef.current.trim(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);

  useEffect(() => {
    if (appendRefreshKey === 0) return;
    void reload(searchRef.current, {
      silent: entriesRef.current.length > 0,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appendRefreshKey]);

  useEffect(() => {
    if (!dialogOpen) {
      searchSkipRef.current = true;
      return;
    }
    if (searchSkipRef.current) {
      searchSkipRef.current = false;
      return;
    }
    const t = setTimeout(() => void reload(search), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, dialogOpen]);

  useEffect(() => {
    useHistoryStore.getState().setSelectedId(selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (!dialogOpen) return;
    if (selectedId == null) {
      setFiles([]);
      setFilesReady(true);
      return;
    }
    const cached = useHistoryStore.getState();
    if (cached.filesVorgangId === selectedId) {
      setFiles(cached.files);
      setFilesReady(true);
    } else {
      setFilesReady(false);
    }
    let cancelled = false;
    void listVorgangDateien(selectedId)
      .then((rows) => {
        if (!cancelled) {
          setFiles(rows);
          useHistoryStore.getState().setFiles(selectedId, rows);
        }
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      })
      .finally(() => {
        if (!cancelled) setFilesReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dialogOpen, selectedId, appendRefreshKey]);

  const selected = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId],
  );
  const latestAppend = appends[0] ?? null;

  const filteredEntries = useMemo(
    () => entries.filter((e) => matchesAmsStatusFilter(e, amsFilter)),
    [entries, amsFilter],
  );

  // Keep selection inside the visible AMS filter set.
  useEffect(() => {
    if (amsFilter === "all") return;
    if (selectedId == null) return;
    if (filteredEntries.some((e) => e.id === selectedId)) return;
    setSelectedId(filteredEntries[0]?.id ?? null);
  }, [amsFilter, filteredEntries, selectedId]);

  useEffect(() => {
    if (!dialogOpen || !selected) {
      setHandoffStatus(null);
      setHandoffReady(true);
      return;
    }
    const cid = selected.correlation_id?.trim() ?? "";
    const vorgangId = selected.id;
    const baseDir = selected.base_output_dir;
    const cachedState = selected.ams_state;
    if (!cid) {
      setHandoffStatus(null);
      setHandoffReady(true);
      return;
    }
    let cancelled = false;

    const mergeStatus = (status: HandoffStatus | null) => {
      if (cancelled) return;
      setHandoffStatus(status);
      if (status) {
        patchEntry(vorgangId, (e) => applyHandoffToEntry(e, status));
      }
    };

    const load = (markReady: boolean) => {
      void getHandoffStatus(cid, baseDir, vorgangId)
        .then(mergeStatus)
        .catch(() => {
          if (!cancelled) {
            const row = entriesRef.current.find((e) => e.id === vorgangId);
            const cached = row ? viewFromVorgangEntry(row) : null;
            if (cached) {
              setHandoffStatus({
                correlation_id: cid,
                state: cached.state,
                updated_at: row?.ams_updated_at ?? "",
                error: cached.errorCode
                  ? {
                      code: cached.errorCode,
                      message: cached.errorMessage ?? "",
                    }
                  : null,
                ams: {
                  history_id: null,
                  archive: cached.archive ?? null,
                },
                source: cached.source ?? "cached",
                offline: true,
              });
            }
          }
        })
        .finally(() => {
          if (!cancelled && markReady) setHandoffReady(true);
        });
    };

    // Show cached immediately; avoid blank flicker.
    const seed = viewFromVorgangEntry(selected);
    if (seed) {
      setHandoffStatus({
        correlation_id: cid,
        state: seed.state,
        updated_at: selected.ams_updated_at,
        error: seed.errorCode
          ? { code: seed.errorCode, message: seed.errorMessage ?? "" }
          : null,
        ams: { history_id: null, archive: seed.archive ?? null },
        source: seed.source ?? "local",
        offline: false,
      });
      setHandoffReady(true);
    } else {
      setHandoffReady(false);
    }

    load(true);
    if (
      isAmsHandoffSettled({
        ams_state: cachedState,
        ams_error_code: selected.ams_error_code,
      })
    ) {
      return () => {
        cancelled = true;
      };
    }
    const interval = window.setInterval(() => load(false), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // selected object identity changes on every AMS merge — key by stable fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dialogOpen,
    selected?.id,
    selected?.correlation_id,
    selected?.base_output_dir,
    selected?.ams_state,
    selected?.ams_error_code,
  ]);

  useEffect(() => {
    if (!dialogOpen) return;
    if (selectedId == null) {
      setAppends([]);
      setAppendsReady(true);
      return;
    }
    const cached = useHistoryStore.getState();
    if (cached.appendsVorgangId === selectedId) {
      setAppends(cached.appends);
      setAppendsReady(true);
    } else {
      setAppendsReady(false);
    }
    let cancelled = false;
    void listVorgangAppends(selectedId)
      .then((rows) => {
        if (!cancelled) {
          setAppends(rows);
          useHistoryStore.getState().setAppends(selectedId, rows);
        }
      })
      .catch(() => {
        if (!cancelled) setAppends([]);
      })
      .finally(() => {
        if (!cancelled) setAppendsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dialogOpen, selectedId, appendRefreshKey]);

  useEffect(() => {
    if (!dialogOpen || !selected) {
      setAppendStatus(null);
      return;
    }
    const latestAppend = appends[0];
    const cid =
      latestAppend?.correlation_id?.trim() ||
      selected.last_append_correlation_id?.trim() ||
      "";
    const vorgangId = selected.id;
    const baseDir =
      latestAppend?.folder_path?.trim() ||
      selected.last_append_folder_path?.trim() ||
      selected.base_output_dir;
    const cachedState =
      latestAppend?.ams_state || selected.last_append_ams_state;
    if (!cid) {
      setAppendStatus(null);
      return;
    }
    let cancelled = false;

    const mergeStatus = (status: HandoffStatus | null) => {
      if (cancelled) return;
      setAppendStatus(status);
      if (status) {
        patchEntry(vorgangId, (e) => applyAppendStatusToEntry(e, status));
        setAppends((prev) => {
          const next = prev.map((row) => applyAppendStatusToRecord(row, status));
          useHistoryStore.getState().setAppends(vorgangId, next);
          return next;
        });
      }
    };

    const load = () => {
      void getHandoffStatus(cid, baseDir, vorgangId)
        .then(mergeStatus)
        .catch(() => {
          if (!cancelled) {
            const cached = latestAppend
              ? appendHandoffStatusFromRecord(latestAppend)
              : appendHandoffStatusFromEntry(
                  entriesRef.current.find((e) => e.id === vorgangId) ??
                    selected,
                );
            if (cached) {
              setAppendStatus({ ...cached, offline: true, source: "cached" });
            }
          }
        });
    };

    const seed = latestAppend
      ? appendHandoffStatusFromRecord(latestAppend)
      : appendHandoffStatusFromEntry(selected);
    if (seed) setAppendStatus(seed);

    load();
    if (
      isAmsHandoffSettled({
        ams_state: cachedState,
        ams_error_code:
          latestAppend?.ams_error_code || selected.last_append_ams_error_code,
      })
    ) {
      return () => {
        cancelled = true;
      };
    }
    const interval = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dialogOpen,
    appendsReady,
    selected?.id,
    appends[0]?.correlation_id,
    appends[0]?.folder_path,
    appends[0]?.ams_state,
    appends[0]?.ams_error_code,
    appends[0]?.ams_error_message,
    selected?.last_append_correlation_id,
    selected?.last_append_folder_path,
    selected?.last_append_ams_state,
    selected?.last_append_ams_error_code,
    selected?.last_append_ams_error_message,
  ]);

  // Background refresh for visible non-terminal AMS handoffs (list chips).
  useEffect(() => {
    if (!dialogOpen || !ready) return;
    let cancelled = false;
    const refresh = () => {
      const pending = entriesRef.current.filter((e) => {
        if (e.id === selectedIdRef.current) return false;
        const mainOpen =
          e.correlation_id?.trim() &&
          !isAmsHandoffSettled({
            ams_state: e.ams_state,
            ams_error_code: e.ams_error_code,
          });
        const appendOpen =
          e.last_append_correlation_id?.trim() &&
          !isAmsHandoffSettled({
            ams_state: e.last_append_ams_state,
            ams_error_code: e.last_append_ams_error_code,
          });
        return mainOpen || appendOpen;
      });
      if (pending.length === 0) return;
      void Promise.all(
        pending.slice(0, 15).flatMap((e) => {
          const jobs: Promise<void>[] = [];
          if (
            e.correlation_id?.trim() &&
            !isAmsHandoffSettled({
              ams_state: e.ams_state,
              ams_error_code: e.ams_error_code,
            }) &&
            e.id !== selectedIdRef.current
          ) {
            jobs.push(
              getHandoffStatus(e.correlation_id, e.base_output_dir, e.id)
                .then((status) => {
                  if (!cancelled && status) {
                    patchEntry(e.id, (row) => applyHandoffToEntry(row, status));
                  }
                })
                .catch(() => {
                  /* keep cached list fields */
                }),
            );
          }
          const appendCid = e.last_append_correlation_id?.trim() ?? "";
          if (
            appendCid &&
            !isAmsHandoffSettled({
              ams_state: e.last_append_ams_state,
              ams_error_code: e.last_append_ams_error_code,
            }) &&
            e.id !== selectedIdRef.current
          ) {
            jobs.push(
              getHandoffStatus(
                appendCid,
                e.last_append_folder_path?.trim() || e.base_output_dir,
                e.id,
              )
                .then((status) => {
                  if (!cancelled && status) {
                    patchEntry(e.id, (row) =>
                      applyAppendStatusToEntry(row, status),
                    );
                  }
                })
                .catch(() => {
                  /* keep cached list fields */
                }),
            );
          }
          return jobs;
        }),
      );
    };
    const start = window.setTimeout(refresh, 1500);
    const interval = window.setInterval(refresh, 20000);
    return () => {
      cancelled = true;
      window.clearTimeout(start);
      window.clearInterval(interval);
    };
  }, [dialogOpen, ready]);

  const selectedMode = selected
    ? entryModeLabel(selected.form_mode, selected.manual_entry_mode)
    : null;
  const lastAppendBusy = Boolean(
    (latestAppend?.correlation_id?.trim() ||
      selected?.last_append_correlation_id?.trim()) &&
      !isAmsHandoffSettled({
        ams_state:
          appendStatus?.state ||
          latestAppend?.ams_state ||
          selected?.last_append_ams_state,
        ams_error_code:
          appendStatus?.error?.code ||
          latestAppend?.ams_error_code ||
          selected?.last_append_ams_error_code,
      }),
  );
  const canAppend =
    Boolean(selected?.correlation_id?.trim()) &&
    (selected?.ams_state ?? "").trim().toLowerCase() === "completed" &&
    !lastAppendBusy &&
    !appendJobActive;
  const canRetry = selected
    ? canRetryVorgangUpload(selected, uploadToServer)
    : false;
  const bulkCandidates = useMemo(
    () => pendingUploadCandidates(entries, uploadToServer),
    [entries, uploadToServer],
  );
  const qrPreview = selected?.qr_preview?.path?.trim()
    ? selected.qr_preview
    : null;

  useEffect(() => {
    if (!qrPreview && qrScanOpen) onQrScanOpenChange(false);
  }, [qrPreview, qrScanOpen, onQrScanOpenChange]);

  useEffect(() => {
    onQrScanOpenChange(false);
    setShowShadow(true);
  }, [selectedId, onQrScanOpenChange]);

  const scanDialogWidth = `min(max(min(22rem, calc(100vw - 2rem)), calc(min(50vh, 28rem) * ${QR_PREVIEW_FRAME_AR} + 3rem)), calc(100vw - 2rem))`;

  const metaMode =
    selected?.video_mode === "handcam" || selected?.video_mode === "outside"
      ? selected.video_mode
      : "";
  const metaFoto =
    metaMode === "handcam"
      ? Boolean(selected?.handcam_foto)
      : Boolean(selected?.outside_foto);
  const metaVideo =
    metaMode === "handcam"
      ? Boolean(selected?.handcam_video)
      : Boolean(selected?.outside_video);

  function toggleCheck(id: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function requestRemoveSelected() {
    if (checked.size === 0) return;
    const ids = [...checked];
    const n = ids.length;
    onRequestConfirm({
      title:
        n === 1
          ? t("history.confirm.removeJobOne")
          : t("history.confirm.removeJobMany", { count: n }),
      description:
        n === 1
          ? t("history.confirm.removeJobOneBody")
          : t("history.confirm.removeJobManyBody"),
      actionLabel: t("common.actions.remove"),
      run: async () => {
        await deleteVorgaenge(ids);
        useHistoryStore.getState().removeVorgaenge(ids);
        setEntries((prev) => prev.filter((e) => !ids.includes(e.id)));
        await reload(search, { silent: true });
      },
    });
  }

  function requestBulkRetry() {
    if (bulkCandidates.length === 0 || retryPreflightBusy) return;
    if (!serverConnected) {
      showWarning(
        t("history.upload.bulkOffline"),
        t("history.upload.bulkTitle"),
      );
      return;
    }
    const n = bulkCandidates.length;
    onRequestConfirm({
      title: t("history.upload.bulkConfirmTitle"),
      description: t("history.upload.bulkConfirmBody", { count: n }),
      actionLabel: t("history.upload.bulkBtn"),
      actionVariant: "default",
      run: async () => {
        onStartBulkRetry(bulkCandidates);
      },
    });
  }

  const showEmptyList = ready && !loading && filteredEntries.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-2">
        <Input
          className="h-8 max-w-xs text-xs"
          placeholder={t("history.searchJobs")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label={t("history.filterStatusAria")}
        >
          {AMS_STATUS_FILTERS.map((id) => (
            <button
              key={id}
              type="button"
              className={cn(
                "inline-flex h-7 items-center rounded border px-2 text-[10px] font-medium transition-colors",
                amsFilter === id
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted/40",
              )}
              aria-pressed={amsFilter === id}
              onClick={() => setAmsFilter(id)}
            >
              {t(`history.filters.${id}`)}
            </button>
          ))}
        </div>
        <span className="ml-auto min-w-[7rem] text-right text-xs text-muted tabular-nums">
          {!ready && filteredEntries.length === 0
            ? t("common.actions.loading")
            : amsFilter === "all"
              ? t("history.jobCount", { count: entries.length })
              : t("history.jobCountFiltered", {
                  filtered: filteredEntries.length,
                  total: entries.length,
                })}
        </span>
        {uploadToServer && bulkCandidates.length > 0 ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={retryPreflightBusy || appendJobActive || !serverConnected}
            title={
              !serverConnected
                ? t("history.upload.bulkOffline")
                : t("history.upload.bulkTitleOk", {
                    count: bulkCandidates.length,
                  })
            }
            onClick={requestBulkRetry}
          >
            {t("history.upload.bulkBtn")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={checked.size === 0}
          onClick={requestRemoveSelected}
        >
          {t("history.removeSelected")}
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="min-h-0 overflow-y-auto overflow-x-hidden rounded-md border border-border/60">
          <table className="w-full table-fixed text-left text-xs">
            <colgroup>
              <col className="w-8" />
              <col className="w-[24%]" />
              <col className="w-[14%]" />
              <col className="w-[18%]" />
              <col className="w-[18%]" />
              <col className="w-[18%]" />
            </colgroup>
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border/60">
                <th className="p-2" />
                <th className="p-2">{t("history.col.guest")}</th>
                <th className="p-2">{t("history.col.date")}</th>
                <th className="p-2">{t("history.col.products")}</th>
                <th className="p-2">{t("history.col.status")}</th>
                <th className="p-2">{t("history.col.created")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredEntries.map((e) => {
                const badges = productBadges(e);
                const baseView = viewFromVorgangEntry(e);
                const amsView =
                  baseView &&
                  handoffStatus?.correlation_id === e.correlation_id &&
                  handoffStatus.offline
                    ? { ...baseView, offline: true }
                    : baseView;
                const amsProblem =
                  amsView != null &&
                  (isAmsCancelled(amsView) ||
                    amsView.state === "rejected" ||
                    amsView.state === "failed");
                return (
                  <tr
                    key={e.id}
                    className={cn(
                      "cursor-pointer border-b border-border/40 border-l-2 border-l-transparent hover:bg-muted/40",
                      selectedId === e.id &&
                        "bg-primary/10 hover:bg-primary/12 border-l-primary",
                    )}
                    onClick={() => setSelectedId(e.id)}
                  >
                    <td className="p-2" onClick={(ev) => ev.stopPropagation()}>
                      <Checkbox
                        checked={checked.has(e.id)}
                        onCheckedChange={() => toggleCheck(e.id)}
                      />
                    </td>
                    <td className="truncate p-2 font-medium" title={e.gast}>
                      {e.gast}
                    </td>
                    <td className="truncate p-2" title={e.datum || undefined}>
                      {e.datum || "—"}
                    </td>
                    <td className="p-2">
                      {badges.length === 0 ? (
                        "—"
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {badges.map((b) => (
                            <ProductStatusChip key={b.key} badge={b} />
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="p-2">
                      <span className="flex flex-wrap items-center gap-1">
                        {amsView ? (
                          <AmsHandoffStatusChip
                            view={amsView}
                            compact
                            onClick={
                              amsProblem
                                ? (ev) => {
                                    ev.stopPropagation();
                                    setSelectedId(e.id);
                                  }
                                : undefined
                            }
                          />
                        ) : null}
                        <UploadStateChip state={e.upload_state ?? ""} />
                        {!amsView &&
                        !["pending", "failed", "uploading"].includes(
                          (e.upload_state ?? "").trim().toLowerCase(),
                        ) ? (
                          <span className="text-muted">—</span>
                        ) : null}
                      </span>
                    </td>
                    <td
                      className="truncate p-2 text-muted"
                      title={formatCreatedAt(e.created_at)}
                    >
                      {formatCreatedAt(e.created_at)}
                    </td>
                  </tr>
                );
              })}
              {showEmptyList && (
                <tr>
                  <td colSpan={6} className="p-4 text-center text-muted">
                    {amsFilter !== "all" && entries.length > 0
                      ? t("history.emptyFilter")
                      : t("history.emptyJobs")}
                  </td>
                </tr>
              )}
              {!ready && filteredEntries.length === 0 &&
                Array.from({ length: 8 }, (_, i) => (
                  <tr key={`sk-${i}`}>
                    <td colSpan={6} className="p-2">
                      <div className="h-4 animate-pulse rounded bg-muted/50" />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <div className="min-h-0 overflow-y-auto overflow-x-hidden rounded-md border border-border/60">
          {selected ? (
            <div className="space-y-2 p-2">
              <div className="space-y-1 border-b border-border/40 pb-2 text-xs">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{selected.gast}</span>
                    {selectedMode && (
                      <span className="text-muted"> · {selectedMode}</span>
                    )}
                  </div>
                  {qrPreview ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 shrink-0 px-0"
                      title={t("form.toolbar.scanFrame")}
                      aria-label={t("form.toolbar.scanFrame")}
                      onClick={() => {
                        setShowShadow(true);
                        onQrScanOpenChange(true);
                      }}
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
                <div className="text-muted">
                  {[
                    selected.ort,
                    selected.tandemmaster &&
                      t("history.ta", { name: selected.tandemmaster }),
                    selected.videospringer &&
                      t("history.vs", { name: selected.videospringer }),
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </div>
                <div className="truncate text-muted" title={selected.base_output_dir}>
                  {selected.base_filename}
                  {selected.encoder ? ` · ${selected.encoder}` : ""}
                  {selected.reused_preview ? ` · ${t("history.previewReuse")}` : ""}
                </div>
                {(selected.kunden_id || selected.booking_id) && (
                  <div className="text-muted">
                    {[
                      selected.kunden_id &&
                        t("history.customer", { id: selected.kunden_id }),
                      selected.booking_id &&
                        t("history.booking", { id: selected.booking_id }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                )}
                {selected.correlation_id?.trim() ? (
                  <div className="pt-1">
                    {!handoffReady && !handoffStatus ? (
                      <div className="text-muted">{t("history.statusLoading")}</div>
                    ) : (
                      <AmsHandoffStepper
                        view={
                          handoffStatus
                            ? viewFromHandoffStatus(handoffStatus)
                            : (viewFromVorgangEntry(selected) ?? {
                                state: "pending",
                              })
                        }
                      />
                    )}
                    <div
                      className="mt-0.5 truncate text-[10px] text-muted-foreground/80"
                      title={selected.correlation_id}
                    >
                      {selected.correlation_id.slice(0, 8)}…
                    </div>
                    {(latestAppend?.correlation_id?.trim() ||
                      selected.last_append_correlation_id?.trim()) ? (
                      <div className="pt-2">
                        <div className="mb-0.5 text-[10px] font-medium text-muted-foreground">
                          {t("history.append")}
                          {(appends.length || selected.append_count) > 1
                            ? ` ${appends.length || selected.append_count}`
                            : ""}
                        </div>
                        <AmsHandoffStepper
                          view={
                            appendStatus
                              ? viewFromHandoffStatus(appendStatus)
                              : (latestAppend
                                  ? viewFromAppendRecord(latestAppend)
                                  : viewFromAppendEntry(selected)) ?? {
                                  state: "pending",
                                }
                          }
                        />
                        <div
                          className="mt-0.5 truncate text-[10px] text-muted-foreground/80"
                          title={
                            latestAppend?.correlation_id ||
                            selected.last_append_correlation_id
                          }
                        >
                          {(latestAppend?.correlation_id ||
                            selected.last_append_correlation_id).slice(0, 8)}
                          …
                        </div>
                      </div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {canRetry ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="default"
                          className="h-7"
                          disabled={
                            retryPreflightBusy ||
                            appendJobActive ||
                            !serverConnected
                          }
                          title={
                            !serverConnected
                              ? t("history.upload.retryOffline")
                              : t("history.upload.retryTitleOk")
                          }
                          onClick={() => {
                            if (!serverConnected) {
                              showWarning(
                                t("history.upload.retryOffline"),
                                t("history.upload.retryTitle"),
                              );
                              return;
                            }
                            onRequestRetryUpload(selected);
                          }}
                        >
                          {t("history.upload.retryBtn")}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="h-7"
                        disabled={!canAppend}
                        title={
                          !selected.correlation_id?.trim()
                            ? t("history.appendTitleLokal")
                            : (selected.ams_state ?? "").trim().toLowerCase() !==
                                "completed"
                              ? t("history.appendTitleWait")
                              : lastAppendBusy || appendJobActive
                                ? t("history.appendTitleBusy")
                                : t("history.appendTitleOk")
                        }
                        onClick={() => onOpenAppend(selected)}
                      >
                        {t("history.appendBtn")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-medium text-muted-foreground">
                  <span>{t("history.files")}</span>
                  {filesReady ? (
                    <span className="tabular-nums">{files.length}</span>
                  ) : null}
                </div>
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 z-[1] bg-card">
                    <tr className="border-b border-border/60">
                      <th className="p-2">{t("history.col.name")}</th>
                      <th className="p-2">{t("history.col.type")}</th>
                      <th className="p-2">{t("history.col.role")}</th>
                      <th className="p-2">{t("history.col.source")}</th>
                      <th className="p-2">{t("history.col.size")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {files.map((f) => (
                      <tr key={f.id} className="border-b border-border/40">
                        <td
                          className="max-w-[220px] truncate p-2"
                          title={f.path ?? f.filename}
                        >
                          {f.filename}
                        </td>
                        <td className="p-2">{f.media_type}</td>
                        <td className="p-2">{roleLabel(f.role)}</td>
                        <td className="p-2">
                          {f.append_id != null ? (
                            <span
                              className="inline-flex rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-violet-900 dark:text-violet-100"
                              title={
                                f.append_folder_name
                                  ? t("history.appendedFolder", {
                                      folder: f.append_folder_name,
                                    })
                                  : t("history.appended")
                              }
                            >
                              {t("history.appended")}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">{t("history.original")}</span>
                          )}
                        </td>
                        <td className="p-2">{formatBytes(f.size_bytes)}</td>
                      </tr>
                    ))}
                    {filesReady && files.length === 0 && (
                      <tr>
                        <td colSpan={5} className="p-4 text-center text-muted">
                          {t("history.noFiles")}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {qrPreview ? (
                <Dialog open={qrScanOpen} onOpenChange={onQrScanOpenChange}>
                  <DialogContent
                    className="z-[60] flex w-auto max-w-[min(56rem,calc(100vw-2rem))] flex-col gap-4"
                    overlayClassName="z-[60]"
                    style={{ width: scanDialogWidth }}
                  >
                    <DialogHeader className="shrink-0">
                      <DialogTitle>{t("form.toolbar.scanTitle")}</DialogTitle>
                      <DialogDescription>
                        {t("history.scanDescriptionJob")}
                      </DialogDescription>
                    </DialogHeader>
                    <QrSpotlightPreview
                      key={qrPreview.path}
                      preview={qrPreview}
                      showSpotlight={showShadow}
                      className="max-w-full"
                    />
                    <div className="grid w-full shrink-0 gap-3 min-[28rem]:grid-cols-[1fr_auto] min-[28rem]:items-stretch">
                      <QrHitMeta
                        className="min-w-0"
                        displayName={selected.gast || null}
                        customerHash={selected.kunden_id_hash}
                        bookingHash={selected.booking_id_hash}
                        media={
                          metaMode || metaFoto || metaVideo
                            ? {
                                mode: metaMode,
                                foto: metaFoto,
                                video: metaVideo,
                              }
                            : null
                        }
                      />
                      <div className="flex flex-col gap-3 min-[28rem]:w-[10.5rem] min-[28rem]:justify-between">
                        <label
                          htmlFor="history-qr-scan-shadow"
                          className="flex h-fit cursor-pointer items-center gap-2.5 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5"
                        >
                          <Switch
                            id="history-qr-scan-shadow"
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
                          onClick={() => onQrScanOpenChange(false)}
                        >
                          {t("common.actions.close")}
                        </Button>
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
              ) : null}
            </div>
          ) : ready ? (
            <div className="flex flex-1 items-center justify-center text-xs text-muted">
              {t("history.selectJob")}
            </div>
          ) : (
            <div className="space-y-2 p-3">
              <div className="h-4 w-2/3 animate-pulse rounded bg-muted/50" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-muted/40" />
              <div className="h-3 w-5/6 animate-pulse rounded bg-muted/40" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MedienPanel({
  dialogOpen,
  onRequestConfirm,
}: {
  dialogOpen: boolean;
  onRequestConfirm: (pending: PendingConfirm) => void;
}) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ProcessedFileEntry[]>(() => {
    const s = useHistoryStore.getState();
    return s.medienLoaded && s.medienQuery === "" ? s.medien : [];
  });
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [period, setPeriod] = useState<PeriodFilter>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(
    () => !useHistoryStore.getState().medienLoaded,
  );
  const [ready, setReady] = useState(
    () => useHistoryStore.getState().medienLoaded,
  );
  const searchRef = useRef(search);
  searchRef.current = search;
  const searchSkipRef = useRef(true);

  async function reload(q?: string, opts?: { silent?: boolean }) {
    const query = q?.trim() || "";
    const silent = Boolean(opts?.silent) && entries.length > 0 && !query;
    if (!silent) setLoading(true);
    try {
      const rows = await listProcessedFiles(1000, query || undefined);
      setEntries(rows);
      useHistoryStore.getState().setMedien(rows, query);
      if (!silent) setSelected(new Set());
    } catch {
      if (!silent) setEntries([]);
    } finally {
      setLoading(false);
      setReady(true);
    }
  }

  useEffect(() => {
    if (!dialogOpen) return;
    const cached = useHistoryStore.getState();
    void reload(searchRef.current, {
      silent: cached.medienLoaded && cached.medienQuery === "" && !searchRef.current.trim(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);

  useEffect(() => {
    if (!dialogOpen) {
      searchSkipRef.current = true;
      return;
    }
    if (searchSkipRef.current) {
      searchSkipRef.current = false;
      return;
    }
    const t = setTimeout(() => void reload(search), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, dialogOpen]);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (typeFilter !== "all" && e.media_type !== typeFilter) return false;
      const ref = e.imported_at || e.backed_up_at || e.first_seen_at;
      if (period !== "all" && !withinPeriod(ref, period)) return false;
      return true;
    });
  }, [entries, typeFilter, period]);

  const stats = useMemo(() => {
    const videos = filtered.filter((e) => e.media_type === "video").length;
    const photos = filtered.filter((e) => e.media_type === "photo").length;
    return t("history.media.stats", {
      total: filtered.length,
      videos,
      photos,
    });
  }, [filtered, t]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function requestRemoveSelected() {
    if (selected.size === 0) return;
    const ids = [...selected];
    const n = ids.length;
    onRequestConfirm({
      title:
        n === 1
          ? t("history.confirm.removeMediaOne")
          : t("history.confirm.removeMediaMany", { count: n }),
      description:
        n === 1
          ? t("history.confirm.removeMediaOneBody")
          : t("history.confirm.removeMediaManyBody"),
      actionLabel: t("common.actions.remove"),
      run: async () => {
        await deleteProcessedFiles(ids);
        useHistoryStore.getState().removeMedien(ids);
        await reload(search);
      },
    });
  }

  function requestPurgeAll() {
    onRequestConfirm({
      title: t("history.confirm.purgeMedia"),
      description: t("history.confirm.purgeMediaBody"),
      actionLabel: t("common.actions.deleteAll"),
      run: async () => {
        await purgeProcessedFiles();
        useHistoryStore.getState().clearMedien();
        await reload(search);
      },
    });
  }

  const showEmpty = ready && !loading && filtered.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex h-8 shrink-0 flex-wrap items-center gap-2">
        <Input
          className="h-8 max-w-xs text-xs"
          placeholder={t("history.searchMedia")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as TypeFilter)}>
          <SelectTrigger className="h-8 w-[110px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("history.filters.all")}</SelectItem>
            <SelectItem value="video">{t("common.labels.videos")}</SelectItem>
            <SelectItem value="photo">{t("common.labels.photos")}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={period} onValueChange={(v) => setPeriod(v as PeriodFilter)}>
          <SelectTrigger className="h-8 w-[140px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("history.media.allTime")}</SelectItem>
            <SelectItem value="today">{t("history.media.today")}</SelectItem>
            <SelectItem value="7d">{t("history.media.last7")}</SelectItem>
            <SelectItem value="30d">{t("history.media.lastMonth")}</SelectItem>
            <SelectItem value="365d">{t("history.media.lastYear")}</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto min-w-[12rem] text-right text-xs text-muted tabular-nums">
          {!ready && filtered.length === 0 ? t("common.actions.loading") : stats}
        </span>
        <Button type="button" variant="destructive" size="sm" onClick={requestPurgeAll}>
          {t("common.actions.deleteAll")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={selected.size === 0}
          onClick={requestRemoveSelected}
        >
          {t("history.removeSelected")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border/60">
        <table className="w-full table-fixed text-left text-xs">
          <colgroup>
            <col className="w-10" />
            <col />
            <col className="w-[12%]" />
            <col className="w-[14%]" />
            <col className="w-[20%]" />
            <col className="w-[20%]" />
          </colgroup>
          <thead className="sticky top-0 bg-card">
            <tr className="border-b border-border/60">
              <th className="p-2" />
              <th className="p-2">{t("media.list.filename")}</th>
              <th className="p-2">{t("history.col.type")}</th>
              <th className="p-2">{t("history.col.size")}</th>
              <th className="p-2">{t("history.media.imported")}</th>
              <th className="p-2">{t("history.media.backedUp")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id} className="border-b border-border/40 hover:bg-muted/40">
                <td className="p-2 align-middle">
                  <div className="flex h-4 w-4 items-center justify-center">
                    <Checkbox
                      checked={selected.has(e.id)}
                      onCheckedChange={() => toggle(e.id)}
                    />
                  </div>
                </td>
                <td className="truncate p-2" title={e.filename}>
                  {e.filename}
                </td>
                <td className="truncate p-2">{e.media_type}</td>
                <td className="truncate p-2">{formatBytes(e.size_bytes)}</td>
                <td className="truncate p-2">
                  {e.imported_at ? formatCreatedAt(e.imported_at) : "—"}
                </td>
                <td className="truncate p-2">
                  {e.backed_up_at ? formatCreatedAt(e.backed_up_at) : "—"}
                </td>
              </tr>
            ))}
            {showEmpty && (
              <tr>
                <td colSpan={6} className="p-4 text-center text-muted">
                  {t("history.media.empty")}
                </td>
              </tr>
            )}
            {!ready && filtered.length === 0 &&
              Array.from({ length: 8 }, (_, i) => (
                <tr key={`sk-m-${i}`}>
                  <td colSpan={6} className="p-2">
                    <div className="h-4 animate-pulse rounded bg-muted/50" />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

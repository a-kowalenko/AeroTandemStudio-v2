import { create } from "zustand";
import type { QrPreview } from "@/lib/tauri";
import { tr } from "@/i18n";

export type DialogKind = "error" | "success" | "warning" | null;

export type DialogVariant = "default" | "qr";

/** SD-workflow (and similar) action rows in SuccessDialog. */
export type DialogActionKind = "qr" | "backup" | "import" | "clear" | "eject";

export type DialogActionTone = "success" | "error" | "warning" | "skipped";

export type DialogActionStatus = {
  kind: DialogActionKind;
  label: string;
  tone: DialogActionTone;
  /** Short result line, e.g. "10 Dateien kopiert". */
  summary: string;
  /** Optional detail (path, error text). */
  detail?: string;
};

export type DialogChoiceOption = {
  id: string;
  label: string;
  detail?: string;
};

export type DialogChoicesOptions = {
  options: DialogChoiceOption[];
  cancelLabel?: string;
  onPick: (id: string) => void;
  onCancel: () => void;
};

export type DialogOptions = {
  autoCloseSecs?: number;
  /** Visual emphasis for QR customer recognition. */
  variant?: DialogVariant;
  /** Prominent line under the title (e.g. customer name). */
  highlight?: string;
  /** Per-action icon + status rows (QR, Backup, Import, Eject, …). */
  actions?: DialogActionStatus[];
  /** Optional QR hit-frame spotlight preview (right column). */
  qrPreview?: QrPreview | null;
  /**
   * Dual-button confirm footer (e.g. QR customer switch).
   * Escape / overlay dismiss calls `onSecondary` (safe default).
   */
  confirm?: DialogConfirmOptions | null;
  /** Equal-weight choices (e.g. Handcam vs Outside). Escape = onCancel. */
  choices?: DialogChoicesOptions | null;
};

export type DialogConfirmOptions = {
  secondaryLabel: string;
  primaryLabel: string;
  onSecondary: () => void;
  onPrimary: () => void;
};

export type SettingsTab =
  | "allgemein"
  | "crew"
  | "qr"
  | "encoding"
  | "sd"
  | "server"
  | "system";

export type SettingsFocusTarget =
  | "server-url"
  | "server-credentials"
  | "ams-bridge-url"
  | "ams-bridge-token";

/** Primary CTA on error dialogs (e.g. deep-link into Settings). */
export type DialogPrimaryAction = {
  label: string;
  openSettings?: {
    tab?: SettingsTab;
    focus?: SettingsFocusTarget;
  };
};

export type ErrorDialogOptions = {
  primaryAction?: DialogPrimaryAction;
};

type UiState = {
  dialogKind: DialogKind;
  dialogTitle: string;
  dialogMessage: string;
  dialogAutoCloseSecs: number | null;
  dialogVariant: DialogVariant;
  dialogHighlight: string;
  dialogActions: DialogActionStatus[];
  dialogQrPreview: QrPreview | null;
  dialogPrimaryAction: DialogPrimaryAction | null;
  dialogConfirm: DialogConfirmOptions | null;
  dialogChoices: DialogChoicesOptions | null;
  loading: boolean;
  loadingMessage: string;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  settingsFocus: SettingsFocusTarget | null;
  /** Bumps so the same focus target re-triggers scroll/highlight. */
  settingsFocusNonce: number;
  /**
   * After QR crew dropdown workflow finishes: pulse Erstellen once it becomes ready.
   */
  createReadyPulsePending: boolean;
  showError: (
    message: string,
    title?: string,
    options?: ErrorDialogOptions,
  ) => void;
  showSuccess: (message: string, title?: string, options?: DialogOptions) => void;
  showWarning: (
    message: string,
    title?: string,
    options?: Pick<DialogOptions, "autoCloseSecs">,
  ) => void;
  closeDialog: () => void;
  setLoading: (loading: boolean, message?: string) => void;
  setSettingsOpen: (open: boolean) => void;
  openSettings: (opts?: {
    tab?: SettingsTab;
    focus?: SettingsFocusTarget;
  }) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  clearSettingsFocus: () => void;
  requestCreateReadyPulse: () => void;
  clearCreateReadyPulse: () => void;
};

const emptyDialogFields = {
  dialogTitle: "",
  dialogMessage: "",
  dialogAutoCloseSecs: null as number | null,
  dialogVariant: "default" as DialogVariant,
  dialogHighlight: "",
  dialogActions: [] as DialogActionStatus[],
  dialogQrPreview: null as QrPreview | null,
  dialogPrimaryAction: null as DialogPrimaryAction | null,
  dialogConfirm: null as DialogConfirmOptions | null,
  dialogChoices: null as DialogChoicesOptions | null,
};

export const useUiStore = create<UiState>((set) => ({
  dialogKind: null,
  ...emptyDialogFields,
  loading: false,
  loadingMessage: "",
  settingsOpen: false,
  settingsTab: "allgemein",
  settingsFocus: null,
  settingsFocusNonce: 0,
  createReadyPulsePending: false,

  showError: (message, title, options) =>
    set({
      dialogKind: "error",
      ...emptyDialogFields,
      dialogTitle: title ?? tr("dialogs.error.defaultTitle"),
      dialogMessage: message,
      dialogPrimaryAction: options?.primaryAction ?? null,
    }),
  showSuccess: (message, title, options) =>
    set({
      dialogKind: "success",
      dialogTitle: title ?? tr("dialogs.success.defaultTitle"),
      dialogMessage: message,
      dialogAutoCloseSecs:
        options?.autoCloseSecs && options.autoCloseSecs > 0
          ? options.autoCloseSecs
          : null,
      dialogVariant: options?.variant ?? "default",
      dialogHighlight: options?.highlight?.trim() ?? "",
      dialogActions: options?.actions?.length ? [...options.actions] : [],
      dialogQrPreview: options?.qrPreview ?? null,
      dialogPrimaryAction: null,
      dialogConfirm: options?.confirm ?? null,
      dialogChoices: options?.choices ?? null,
    }),
  showWarning: (message, title, options) =>
    set({
      dialogKind: "warning",
      ...emptyDialogFields,
      dialogTitle: title ?? tr("dialogs.warning.defaultTitle"),
      dialogMessage: message,
      dialogAutoCloseSecs:
        options?.autoCloseSecs && options.autoCloseSecs > 0
          ? options.autoCloseSecs
          : null,
    }),
  closeDialog: () =>
    set({
      dialogKind: null,
      ...emptyDialogFields,
    }),
  setLoading: (loading, message) =>
    set({ loading, loadingMessage: message ?? tr("common.actions.pleaseWait") }),
  setSettingsOpen: (open) =>
    set((state) =>
      open
        ? { settingsOpen: true }
        : {
            settingsOpen: false,
            settingsFocus: null,
            settingsTab: state.settingsTab,
          },
    ),
  openSettings: (opts) =>
    set((state) => ({
      settingsOpen: true,
      settingsTab: opts?.tab ?? "allgemein",
      settingsFocus: opts?.focus ?? null,
      settingsFocusNonce: opts?.focus
        ? state.settingsFocusNonce + 1
        : state.settingsFocusNonce,
    })),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  clearSettingsFocus: () => set({ settingsFocus: null }),
  requestCreateReadyPulse: () => set({ createReadyPulsePending: true }),
  clearCreateReadyPulse: () => set({ createReadyPulsePending: false }),
}));

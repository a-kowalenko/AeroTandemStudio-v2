import { create } from "zustand";
import type { QrPreview } from "@/lib/tauri";

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
  | "sd";

export type SettingsFocusTarget = "server-url" | "server-credentials";

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
  loading: boolean;
  loadingMessage: string;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  settingsFocus: SettingsFocusTarget | null;
  /** Bumps so the same focus target re-triggers scroll/highlight. */
  settingsFocusNonce: number;
  showError: (
    message: string,
    title?: string,
    options?: ErrorDialogOptions,
  ) => void;
  showSuccess: (message: string, title?: string, options?: DialogOptions) => void;
  showWarning: (message: string, title?: string) => void;
  closeDialog: () => void;
  setLoading: (loading: boolean, message?: string) => void;
  setSettingsOpen: (open: boolean) => void;
  openSettings: (opts?: {
    tab?: SettingsTab;
    focus?: SettingsFocusTarget;
  }) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  clearSettingsFocus: () => void;
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

  showError: (message, title = "Fehler", options) =>
    set({
      dialogKind: "error",
      ...emptyDialogFields,
      dialogTitle: title,
      dialogMessage: message,
      dialogPrimaryAction: options?.primaryAction ?? null,
    }),
  showSuccess: (message, title = "Erfolg", options) =>
    set({
      dialogKind: "success",
      dialogTitle: title,
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
    }),
  showWarning: (message, title = "Hinweis") =>
    set({
      dialogKind: "warning",
      ...emptyDialogFields,
      dialogTitle: title,
      dialogMessage: message,
    }),
  closeDialog: () =>
    set({
      dialogKind: null,
      ...emptyDialogFields,
    }),
  setLoading: (loading, message = "Bitte warten…") =>
    set({ loading, loadingMessage: message }),
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
}));

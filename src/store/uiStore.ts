import { create } from "zustand";

export type DialogKind = "error" | "success" | "warning" | null;

export type DialogVariant = "default" | "qr";

/** SD-workflow (and similar) action rows in SuccessDialog. */
export type DialogActionKind = "qr" | "backup" | "import" | "eject";

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
};

type UiState = {
  dialogKind: DialogKind;
  dialogTitle: string;
  dialogMessage: string;
  dialogAutoCloseSecs: number | null;
  dialogVariant: DialogVariant;
  dialogHighlight: string;
  dialogActions: DialogActionStatus[];
  loading: boolean;
  loadingMessage: string;
  settingsOpen: boolean;
  showError: (message: string, title?: string) => void;
  showSuccess: (message: string, title?: string, options?: DialogOptions) => void;
  showWarning: (message: string, title?: string) => void;
  closeDialog: () => void;
  setLoading: (loading: boolean, message?: string) => void;
  setSettingsOpen: (open: boolean) => void;
};

const emptyDialogFields = {
  dialogTitle: "",
  dialogMessage: "",
  dialogAutoCloseSecs: null as number | null,
  dialogVariant: "default" as DialogVariant,
  dialogHighlight: "",
  dialogActions: [] as DialogActionStatus[],
};

export const useUiStore = create<UiState>((set) => ({
  dialogKind: null,
  ...emptyDialogFields,
  loading: false,
  loadingMessage: "",
  settingsOpen: false,

  showError: (message, title = "Fehler") =>
    set({
      dialogKind: "error",
      ...emptyDialogFields,
      dialogTitle: title,
      dialogMessage: message,
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
  setSettingsOpen: (open) => set({ settingsOpen: open }),
}));

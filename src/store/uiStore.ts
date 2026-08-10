import { create } from "zustand";

export type DialogKind = "error" | "success" | "warning" | null;

export type DialogVariant = "default" | "qr";

export type DialogOptions = {
  autoCloseSecs?: number;
  /** Visual emphasis for QR customer recognition. */
  variant?: DialogVariant;
  /** Prominent line under the title (e.g. customer name). */
  highlight?: string;
};

type UiState = {
  dialogKind: DialogKind;
  dialogTitle: string;
  dialogMessage: string;
  dialogAutoCloseSecs: number | null;
  dialogVariant: DialogVariant;
  dialogHighlight: string;
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

export const useUiStore = create<UiState>((set) => ({
  dialogKind: null,
  dialogTitle: "",
  dialogMessage: "",
  dialogAutoCloseSecs: null,
  dialogVariant: "default",
  dialogHighlight: "",
  loading: false,
  loadingMessage: "",
  settingsOpen: false,

  showError: (message, title = "Fehler") =>
    set({
      dialogKind: "error",
      dialogTitle: title,
      dialogMessage: message,
      dialogAutoCloseSecs: null,
      dialogVariant: "default",
      dialogHighlight: "",
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
    }),
  showWarning: (message, title = "Hinweis") =>
    set({
      dialogKind: "warning",
      dialogTitle: title,
      dialogMessage: message,
      dialogAutoCloseSecs: null,
      dialogVariant: "default",
      dialogHighlight: "",
    }),
  closeDialog: () =>
    set({
      dialogKind: null,
      dialogTitle: "",
      dialogMessage: "",
      dialogAutoCloseSecs: null,
      dialogVariant: "default",
      dialogHighlight: "",
    }),
  setLoading: (loading, message = "Bitte warten…") =>
    set({ loading, loadingMessage: message }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
}));

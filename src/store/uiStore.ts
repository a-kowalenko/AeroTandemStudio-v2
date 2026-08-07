import { create } from "zustand";

export type DialogKind = "error" | "success" | "warning" | null;

export type DialogOptions = {
  autoCloseSecs?: number;
};

type UiState = {
  dialogKind: DialogKind;
  dialogTitle: string;
  dialogMessage: string;
  dialogAutoCloseSecs: number | null;
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
  loading: false,
  loadingMessage: "",
  settingsOpen: false,

  showError: (message, title = "Fehler") =>
    set({
      dialogKind: "error",
      dialogTitle: title,
      dialogMessage: message,
      dialogAutoCloseSecs: null,
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
    }),
  showWarning: (message, title = "Hinweis") =>
    set({
      dialogKind: "warning",
      dialogTitle: title,
      dialogMessage: message,
      dialogAutoCloseSecs: null,
    }),
  closeDialog: () =>
    set({
      dialogKind: null,
      dialogTitle: "",
      dialogMessage: "",
      dialogAutoCloseSecs: null,
    }),
  setLoading: (loading, message = "Bitte warten…") =>
    set({ loading, loadingMessage: message }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
}));

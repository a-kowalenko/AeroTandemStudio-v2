import { create } from "zustand";

export type DialogKind = "error" | "success" | "warning" | null;

type UiState = {
  dialogKind: DialogKind;
  dialogTitle: string;
  dialogMessage: string;
  loading: boolean;
  loadingMessage: string;
  settingsOpen: boolean;
  showError: (message: string, title?: string) => void;
  showSuccess: (message: string, title?: string) => void;
  showWarning: (message: string, title?: string) => void;
  closeDialog: () => void;
  setLoading: (loading: boolean, message?: string) => void;
  setSettingsOpen: (open: boolean) => void;
};

export const useUiStore = create<UiState>((set) => ({
  dialogKind: null,
  dialogTitle: "",
  dialogMessage: "",
  loading: false,
  loadingMessage: "",
  settingsOpen: false,

  showError: (message, title = "Fehler") =>
    set({ dialogKind: "error", dialogTitle: title, dialogMessage: message }),
  showSuccess: (message, title = "Erfolg") =>
    set({ dialogKind: "success", dialogTitle: title, dialogMessage: message }),
  showWarning: (message, title = "Hinweis") =>
    set({ dialogKind: "warning", dialogTitle: title, dialogMessage: message }),
  closeDialog: () => set({ dialogKind: null, dialogTitle: "", dialogMessage: "" }),
  setLoading: (loading, message = "Bitte warten…") =>
    set({ loading, loadingMessage: message }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
}));

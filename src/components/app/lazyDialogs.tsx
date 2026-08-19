import { lazy } from "react";

export const LazyHistoryDialog = lazy(() =>
  import("../HistoryDialog").then((m) => ({ default: m.HistoryDialog })),
);

export const LazySettingsDialog = lazy(() =>
  import("../settings/SettingsDialog").then((m) => ({
    default: m.SettingsDialog,
  })),
);

export const LazySetupWizard = lazy(() =>
  import("../SetupWizard").then((m) => ({ default: m.SetupWizard })),
);

export const LazySdFileSelector = lazy(() =>
  import("../SdFileSelector").then((m) => ({ default: m.SdFileSelector })),
);

export const LazyVideoCutter = lazy(() =>
  import("../VideoCutter").then((m) => ({ default: m.VideoCutter })),
);

export const LazyPhotoEditor = lazy(() =>
  import("../PhotoEditor").then((m) => ({ default: m.PhotoEditor })),
);

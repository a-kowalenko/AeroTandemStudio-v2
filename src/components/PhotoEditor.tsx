import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { RotateCw } from "lucide-react";
import { MediaEditShell, type MediaEditModeOption } from "./MediaEditShell";
import { MediaEditRotateBar } from "./MediaEditRotateBar";
import { useUiStore } from "../store/uiStore";
import { usePhotoStore } from "../store/photoStore";
import { previewRotateMediaStyle } from "../lib/mediaPreviewRotate";
import { cn } from "../lib/utils";

export type PhotoEditorResult =
  | { action: "cancel" }
  | { action: "apply_rotate"; degrees: number };

type PhotoEditMode = "rotate";

type PhotoEditorProps = {
  open: boolean;
  photoPath: string | null;
  onClose: () => void;
  onComplete: (result: PhotoEditorResult) => void;
};

const PHOTO_MODES: MediaEditModeOption<PhotoEditMode>[] = [
  {
    id: "rotate",
    label: "Drehen",
    icon: <RotateCw className="h-4 w-4" strokeWidth={2} />,
  },
];

/**
 * Apple Photos–style photo edit shell (modes ready for crop/filters later).
 */
export function PhotoEditor({
  open,
  photoPath,
  onClose,
  onComplete,
}: PhotoEditorProps) {
  const committedRef = useRef(false);
  const showWarning = useUiStore((s) => s.showWarning);
  const getMediaRevision = usePhotoStore((s) => s.getMediaRevision);
  const [mode, setMode] = useState<PhotoEditMode>("rotate");
  const [pendingRotateDeg, setPendingRotateDeg] = useState(0);

  useEffect(() => {
    if (!open) {
      setPendingRotateDeg(0);
      setMode("rotate");
      return;
    }
    committedRef.current = false;
    setPendingRotateDeg(0);
    setMode("rotate");
  }, [open, photoPath]);

  function finish(result: PhotoEditorResult) {
    if (committedRef.current) return;
    committedRef.current = true;
    onComplete(result);
    onClose();
  }

  function cancel() {
    if (committedRef.current) {
      onClose();
      return;
    }
    committedRef.current = true;
    onComplete({ action: "cancel" });
    onClose();
  }

  function applyRotate() {
    const deg = ((pendingRotateDeg % 360) + 360) % 360;
    if (deg === 0) {
      showWarning("Keine Drehung ausgewählt.", "Keine Änderung");
      return;
    }
    finish({ action: "apply_rotate", degrees: deg });
  }

  const rev = photoPath ? getMediaRevision(photoPath) : 0;
  const base = photoPath ? convertFileSrc(photoPath) : null;
  const src =
    open && base
      ? `${base}${base.includes("?") ? "&" : "?"}r=${rev}`
      : null;

  const rotatePending = ((pendingRotateDeg % 360) + 360) % 360 !== 0;
  const rotateMediaStyle = previewRotateMediaStyle(pendingRotateDeg);

  return (
    <MediaEditShell
      open={open}
      title="Bearbeiten"
      description={photoPath}
      mode={mode}
      modes={PHOTO_MODES}
      onModeChange={setMode}
      onCancel={cancel}
      onDone={applyRotate}
      doneEnabled={rotatePending}
      controls={
        mode === "rotate" ? (
          <MediaEditRotateBar
            degrees={pendingRotateDeg}
            onRotateCw={() => setPendingRotateDeg((d) => d + 90)}
            onRotateCcw={() => setPendingRotateDeg((d) => d - 90)}
            onReset={() => setPendingRotateDeg(0)}
          />
        ) : null
      }
    >
      <div className="relative h-full min-h-0 w-full overflow-hidden">
        {src ? (
          <img
            src={src}
            alt="Foto"
            className={cn(
              "object-contain transition-transform duration-200",
              rotateMediaStyle ? null : "h-full w-full",
            )}
            style={rotateMediaStyle}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-white/50">
            Kein Foto
          </div>
        )}
      </div>
    </MediaEditShell>
  );
}

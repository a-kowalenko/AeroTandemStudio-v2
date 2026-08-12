import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

export function QrTab({ draft, patch }: SettingsTabBaseProps) {
  return (
    <div className="space-y-4">
      <SettingsSection
        title="Auto-Scan beim Import"
        description="Nach Drag & Drop, Dateiauswahl oder SD-Import werden neue Dateien automatisch auf QR geprüft. Die Schalter stehen auch direkt unter der Medien-Dropzone."
      >
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.qr_check_enabled}
            onCheckedChange={(v) => patch("qr_check_enabled", v === true)}
          />
          Videos beim Import automatisch scannen
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.photo_qr_check_enabled}
            onCheckedChange={(v) => patch("photo_qr_check_enabled", v === true)}
          />
          Fotos beim Import automatisch scannen
        </label>
      </SettingsSection>

      <SettingsSection title="Scan-Parameter">
        <div className="space-y-1.5">
          <Label>QR Video-Scan (Sekunden)</Label>
          <Input
            type="number"
            min={1}
            max={30}
            value={draft.qr_video_scan_seconds}
            onChange={(e) =>
              patch(
                "qr_video_scan_seconds",
                Math.max(1, Number(e.target.value) || 5),
              )
            }
          />
          <p className="text-[11px] text-muted">
            Wie viele Sekunden vom Clip-Anfang (und parallele Offsets) gelesen werden.
          </p>
        </div>
      </SettingsSection>

      <SettingsSection title="Nach QR-Analyse">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.qr_remove_photo_after_scan}
            onCheckedChange={(v) =>
              patch("qr_remove_photo_after_scan", v === true)
            }
          />
          QR-Foto nach erfolgreicher Analyse entfernen
        </label>
        <p className="pl-6 text-[11px] leading-relaxed text-muted">
          Nachbarfotos derselben Serie (≤10s Abstand) werden in beide Richtungen
          geprüft; nach 3 Fotos ohne QR je Richtung Stopp.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.qr_remove_video_after_scan}
            onCheckedChange={(v) =>
              patch("qr_remove_video_after_scan", v === true)
            }
          />
          QR-Videoclip nach erfolgreicher Analyse entfernen
        </label>
        <div
          className={
            draft.qr_remove_video_after_scan
              ? "space-y-1.5 pl-6"
              : "pointer-events-none space-y-1.5 pl-6 opacity-50"
          }
        >
          <Label>Max. Clip-Länge für Löschung (Sek.)</Label>
          <Input
            type="number"
            min={1}
            max={300}
            value={draft.qr_remove_video_max_duration_sec}
            disabled={!draft.qr_remove_video_after_scan}
            onChange={(e) => {
              const n = Number(e.target.value);
              patch(
                "qr_remove_video_max_duration_sec",
                Number.isFinite(n) ? Math.min(300, Math.max(1, Math.round(n))) : 10,
              );
            }}
          />
          <p className="text-[11px] text-muted">
            Nur Clips mit dieser Länge oder kürzer werden entfernt (Standard: 10s).
          </p>
        </div>
      </SettingsSection>
    </div>
  );
}

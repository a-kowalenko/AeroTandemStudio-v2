import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { showAdvanced } from "@/lib/settingsUi";
import { SettingsAccordion } from "../SettingsAccordion";
import { SettingsHintIcon } from "../SettingsHintIcon";
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

export function QrTab({ draft, patch, patchNow, disclosure }: SettingsTabBaseProps) {
  const { t } = useTranslation();
  const advanced = showAdvanced(disclosure);

  return (
    <div className="space-y-4">
      <SettingsSection
        title={t("settings.qr.autoScan.title")}
        description={t("settings.qr.autoScan.description")}
      >
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.qr_check_enabled}
            onCheckedChange={(v) => patchNow("qr_check_enabled", v === true)}
          />
          {t("settings.qr.autoScan.videos")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.photo_qr_check_enabled}
            onCheckedChange={(v) =>
              patchNow("photo_qr_check_enabled", v === true)
            }
          />
          {t("settings.qr.autoScan.photos")}
        </label>
      </SettingsSection>

      {advanced ? (
      <SettingsAccordion title={t("settings.moreOptions")}>
      <SettingsSection title={t("settings.qr.params.title")}>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Label>{t("settings.qr.params.videoSeconds")}</Label>
            <SettingsHintIcon
              text={t("settings.qr.params.videoSecondsHint")}
            />
          </div>
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
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.qr.after.title")}>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.qr_remove_photo_after_scan}
            onCheckedChange={(v) =>
              patchNow("qr_remove_photo_after_scan", v === true)
            }
          />
          <span className="inline-flex items-center gap-1.5">
            {t("settings.qr.after.removePhoto")}
            <SettingsHintIcon
              text={t("settings.qr.after.removePhotoHint")}
            />
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.qr_remove_video_after_scan}
            onCheckedChange={(v) =>
              patchNow("qr_remove_video_after_scan", v === true)
            }
          />
          {t("settings.qr.after.removeVideo")}
        </label>
        <div
          className={
            draft.qr_remove_video_after_scan
              ? "space-y-1.5 pl-6"
              : "pointer-events-none space-y-1.5 pl-6 opacity-50"
          }
        >
          <div className="flex items-center gap-1.5">
            <Label>{t("settings.qr.after.maxDuration")}</Label>
            <SettingsHintIcon
              text={t("settings.qr.after.maxDurationHint")}
            />
          </div>
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
        </div>
      </SettingsSection>
      </SettingsAccordion>
      ) : null}
    </div>
  );
}

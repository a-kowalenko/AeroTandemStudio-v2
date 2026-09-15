import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { normalizeBodyConcatMode } from "@/lib/bodyConcatMode";
import { showAdvanced } from "@/lib/settingsUi";
import {
  VIDEO_CRF_OPTIONS,
  nearestVideoCrf,
  videoCrfLabelKey,
} from "@/lib/videoCrf";
import { SettingsHintIcon } from "../SettingsHintIcon";
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

export function EncodingTab({
  draft,
  patch: _patch,
  patchNow,
  disclosure,
}: SettingsTabBaseProps) {
  const { t } = useTranslation();
  const advanced = showAdvanced(disclosure);

  return (
    <div className="space-y-4">
      <SettingsSection
        title={t("settings.encoding.standard.title")}
        description={t("settings.encoding.standard.description")}
      >
        {advanced ? (
          <>
            <div className="space-y-1.5">
              <Label>{t("settings.encoding.codec")}</Label>
              <Select
                value={draft.video_codec}
                onValueChange={(v) => patchNow("video_codec", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {t("settings.encoding.codecAuto")}
                  </SelectItem>
                  <SelectItem value="h264">H.264</SelectItem>
                  <SelectItem value="h265">H.265</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>{t("settings.encoding.strategy")}</Label>
              <Select
                value={draft.encoding_strategy}
                onValueChange={(v) => patchNow("encoding_strategy", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="per_clip">
                    {t("settings.encoding.strategyPerClip")}
                  </SelectItem>
                  <SelectItem value="combined">
                    {t("settings.encoding.strategyCombined")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        ) : null}

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.hardware_acceleration_enabled}
            onCheckedChange={(v) =>
              patchNow("hardware_acceleration_enabled", v === true)
            }
          />
          {t("settings.encoding.hwAccel")}
        </label>

        {advanced ? (
          <>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.parallel_processing_enabled}
                onCheckedChange={(v) =>
                  patchNow("parallel_processing_enabled", v === true)
                }
              />
              {t("settings.encoding.parallel")}
            </label>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.speculative_create_enabled !== false}
                onCheckedChange={(v) =>
                  patchNow("speculative_create_enabled", v === true)
                }
              />
              <span className="inline-flex items-center gap-1.5">
                {t("settings.encoding.speculativeCreate")}
                <SettingsHintIcon
                  text={t("settings.encoding.speculativeCreateHint")}
                />
              </span>
            </label>

            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label>{t("settings.encoding.concat")}</Label>
                <SettingsHintIcon text={t("settings.encoding.concatHint")} />
              </div>
              <Select
                value={normalizeBodyConcatMode(draft.body_concat_mode)}
                onValueChange={(v) => patchNow("body_concat_mode", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fast">
                    {t("settings.encoding.concatFast")}
                  </SelectItem>
                  <SelectItem value="compatible">
                    {t("settings.encoding.concatCompatible")}
                  </SelectItem>
                  <SelectItem value="legacy">
                    {t("settings.encoding.concatLegacy")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        ) : null}
      </SettingsSection>

      {advanced ? (
        <SettingsSection
          title={t("settings.encoding.quality.title")}
          description={t("settings.encoding.quality.description")}
        >
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Label>{t("settings.encoding.previewCrf")}</Label>
              <SettingsHintIcon text={t("settings.encoding.crfHint")} />
            </div>
            <Select
              value={String(nearestVideoCrf(draft.preview_encode_crf))}
              onValueChange={(v) => patchNow("preview_encode_crf", Number(v))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VIDEO_CRF_OPTIONS.map((crf) => (
                  <SelectItem key={crf} value={String(crf)}>
                    {t(videoCrfLabelKey(crf))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsSection>
      ) : null}

      {advanced ? (
        <SettingsSection
          title={t("settings.encoding.intro.title")}
          description={t("settings.encoding.intro.description")}
        >
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={draft.intro_enabled}
              onCheckedChange={(v) => patchNow("intro_enabled", v === true)}
            />
            {t("settings.encoding.introEnabled")}
          </label>

          <div className="space-y-1.5">
            <Label>{t("settings.encoding.introDuration")}</Label>
            <Select
              value={String(draft.dauer)}
              onValueChange={(v) => patchNow("dauer", Number(v))}
              disabled={!draft.intro_enabled}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsSection>
      ) : null}
    </div>
  );
}

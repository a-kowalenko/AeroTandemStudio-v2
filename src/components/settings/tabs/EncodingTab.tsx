import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
import { SettingsAccordion } from "../SettingsAccordion";
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

type Props = SettingsTabBaseProps & {
  /** Wizard custom path: codec/strategy/HW + intro/concat accordion. */
  layout?: "settings" | "wizard";
};

export function EncodingTab({
  draft,
  patch,
  patchNow,
  disclosure,
  layout = "settings",
}: Props) {
  const { t } = useTranslation();
  const wizard = layout === "wizard";
  const advanced = wizard || showAdvanced(disclosure);

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
              <SelectItem value="auto">{t("settings.encoding.codecAuto")}</SelectItem>
              <SelectItem value="h264">H.264</SelectItem>
              <SelectItem value="h265">H.265</SelectItem>
              <SelectItem value="vp9">VP9</SelectItem>
              <SelectItem value="av1">AV1</SelectItem>
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

        {advanced && !wizard ? (
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

            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={draft.speculative_create_enabled !== false}
                onCheckedChange={(v) =>
                  patchNow("speculative_create_enabled", v === true)
                }
              />
              <span className="min-w-0" title={t("settings.encoding.speculativeCreateHint")}>
                <span className="block">{t("settings.encoding.speculativeCreate")}</span>
              </span>
            </label>

            <div className="space-y-1.5">
              <Label>{t("settings.encoding.concat")}</Label>
              <Select
                value={normalizeBodyConcatMode(draft.body_concat_mode)}
                onValueChange={(v) => patchNow("body_concat_mode", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fast">{t("settings.encoding.concatFast")}</SelectItem>
                  <SelectItem value="compatible">
                    {t("settings.encoding.concatCompatible")}
                  </SelectItem>
                  <SelectItem value="legacy">
                    {t("settings.encoding.concatLegacy")}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p
                className="whitespace-pre-line text-[11px] leading-snug text-muted"
                title={t("settings.encoding.concatHint")}
              >
                {t("settings.encoding.concatHint")}
              </p>
            </div>
          </>
        ) : null}
      </SettingsSection>

      {advanced ? (
        <SettingsAccordion title={t("settings.encoding.advanced")}>
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
          <div className="space-y-1.5">
            <Label>{t("settings.encoding.introMux")}</Label>
            <Select
              value={
                draft.intro_mux_mode === "stream_copy"
                  ? "stream_copy"
                  : "reencode"
              }
              onValueChange={(v) => patchNow("intro_mux_mode", v)}
              disabled={!draft.intro_enabled}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="reencode">
                  {t("settings.encoding.introMuxReencode")}
                </SelectItem>
                <SelectItem value="stream_copy">
                  {t("settings.encoding.introMuxCopy")}
                </SelectItem>
              </SelectContent>
            </Select>
            <p
              className="text-[11px] leading-snug text-muted"
              title={t("settings.encoding.introMuxHint")}
            >
              {t("settings.encoding.introMuxHint")}
            </p>
            <p
              className="text-[11px] leading-snug text-muted"
              title={t("settings.encoding.previewReuseHint")}
            >
              {t("settings.encoding.previewReuseHint")}
            </p>
          </div>

          {wizard ? (
            <div className="space-y-1.5">
              <Label>{t("settings.encoding.concat")}</Label>
              <Select
                value={normalizeBodyConcatMode(draft.body_concat_mode)}
                onValueChange={(v) => patchNow("body_concat_mode", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fast">{t("settings.encoding.concatFast")}</SelectItem>
                  <SelectItem value="compatible">
                    {t("settings.encoding.concatCompatible")}
                  </SelectItem>
                  <SelectItem value="legacy">
                    {t("settings.encoding.concatLegacy")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : (
            <>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.reencode_matching_clips}
                  onCheckedChange={(v) =>
                    patchNow("reencode_matching_clips", v === true)
                  }
                />
                {t("settings.encoding.reencodeMatching")}
              </label>

              <div className="space-y-1.5">
                <Label>{t("settings.encoding.previewCrf")}</Label>
                <Input
                  type="number"
                  min={0}
                  max={51}
                  value={draft.preview_encode_crf}
                  onChange={(e) =>
                    patch("preview_encode_crf", Number(e.target.value) || 18)
                  }
                />
              </div>
            </>
          )}
        </SettingsAccordion>
      ) : null}
    </div>
  );
}

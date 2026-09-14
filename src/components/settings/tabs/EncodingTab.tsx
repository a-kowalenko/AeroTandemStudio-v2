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
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

/** Preset CRF steps for the quality dropdown (lower = better / larger). */
const VIDEO_CRF_OPTIONS = [18, 20, 23, 26] as const;

function nearestVideoCrf(raw: number): number {
  let best: number = VIDEO_CRF_OPTIONS[0];
  let bestDist = Math.abs(raw - best);
  for (const v of VIDEO_CRF_OPTIONS) {
    const d = Math.abs(raw - v);
    if (d < bestDist) {
      best = v;
      bestDist = d;
    }
  }
  return best;
}

type Props = SettingsTabBaseProps & {
  /** Wizard custom path: codec/strategy/HW + intro/concat. */
  layout?: "settings" | "wizard";
};

export function EncodingTab({
  draft,
  patch: _patch,
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
                  <SelectItem value="auto">
                    {t("settings.encoding.codecAuto")}
                  </SelectItem>
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
              <span
                className="min-w-0"
                title={t("settings.encoding.speculativeCreateHint")}
              >
                <span className="block">
                  {t("settings.encoding.speculativeCreate")}
                </span>
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

      {advanced && !wizard ? (
        <SettingsSection
          title={t("settings.encoding.quality.title")}
          description={t("settings.encoding.quality.description")}
        >
          <div className="space-y-1.5">
            <Label>{t("settings.encoding.previewCrf")}</Label>
            <Select
              value={String(nearestVideoCrf(draft.preview_encode_crf))}
              onValueChange={(v) => patchNow("preview_encode_crf", Number(v))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="18">
                  {t("settings.encoding.crfVeryHigh")}
                </SelectItem>
                <SelectItem value="20">
                  {t("settings.encoding.crfHigh")}
                </SelectItem>
                <SelectItem value="23">
                  {t("settings.encoding.crfBalanced")}
                </SelectItem>
                <SelectItem value="26">
                  {t("settings.encoding.crfSmall")}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] leading-snug text-muted">
              {t("settings.encoding.crfHint")}
            </p>
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
          ) : null}
        </SettingsSection>
      ) : null}
    </div>
  );
}

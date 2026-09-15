import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { normalizeBodyConcatMode } from "@/lib/bodyConcatMode";
import { PHOTO_EXTENSIONS, VIDEO_EXTENSIONS, mediaKind } from "@/lib/media";
import { probeOutroAsset } from "@/lib/tauri";
import { showAdvanced } from "@/lib/settingsUi";
import {
  VIDEO_CRF_OPTIONS,
  nearestVideoCrf,
  videoCrfLabelKey,
} from "@/lib/videoCrf";
import { SettingsHintIcon } from "../SettingsHintIcon";
import { SettingsSection } from "../SettingsSection";
import { OutroMediaPreview } from "../OutroMediaPreview";
import type { SettingsTabBaseProps } from "../types";

export function EncodingTab({
  draft,
  patch: _patch,
  patchNow,
  disclosure,
}: SettingsTabBaseProps) {
  const { t } = useTranslation();
  const advanced = showAdvanced(disclosure);

  // Phase 50 — Outro asset picker / probe (duration + existence).
  const outroPath = draft.outro_path ?? "";
  // Unknown extensions are treated as photo (parity with Rust outro_media_kind).
  const outroKind = outroPath ? (mediaKind(outroPath) ?? "photo") : null;
  const outroFilename = outroPath.replace(/\\/g, "/").split("/").pop() ?? outroPath;
  const [outroProbe, setOutroProbe] = useState<{
    exists: boolean;
    durationSecs: number | null;
  }>({ exists: true, durationSecs: null });

  const refreshOutroProbe = useCallback(async (path: string) => {
    if (!path.trim()) {
      setOutroProbe({ exists: false, durationSecs: null });
      return;
    }
    try {
      const p = await probeOutroAsset(path);
      setOutroProbe({ exists: p.exists, durationSecs: p.duration_secs });
    } catch {
      setOutroProbe({ exists: false, durationSecs: null });
    }
  }, []);

  useEffect(() => {
    if (outroPath) void refreshOutroProbe(outroPath);
  }, [outroPath, refreshOutroProbe]);

  const pickOutro = useCallback(async () => {
    const selected = await openDialog({
      title: t("settings.encoding.outro.pick"),
      multiple: false,
      filters: [
        {
          name: t("settings.encoding.outro.mediaFilter"),
          extensions: [...VIDEO_EXTENSIONS, ...PHOTO_EXTENSIONS],
        },
      ],
    });
    if (typeof selected === "string" && selected) {
      patchNow("outro_path", selected);
      patchNow("outro_enabled", true);
      void refreshOutroProbe(selected);
    }
  }, [patchNow, refreshOutroProbe, t]);

  const removeOutro = useCallback(() => {
    patchNow("outro_path", "");
    patchNow("outro_enabled", false);
    setOutroProbe({ exists: false, durationSecs: null });
  }, [patchNow]);

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

      {advanced ? (
        <SettingsSection
          title={t("settings.encoding.outro.title")}
          description={t("settings.encoding.outro.description")}
          aside={
            outroPath && (outroKind === "photo" || outroKind === "video") ? (
              <div className="w-44 space-y-1.5 sm:w-52 md:w-56">
                <OutroMediaPreview
                  path={outroPath}
                  kind={outroKind}
                  exists={outroProbe.exists}
                  className="w-full"
                />
                <p
                  className="truncate text-center text-xs text-muted-foreground"
                  title={outroFilename}
                >
                  {outroFilename}
                </p>
              </div>
            ) : null
          }
        >
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.outro_enabled}
                onCheckedChange={(v) => {
                  const on = v === true;
                  patchNow("outro_enabled", on);
                  if (on && !outroPath) void pickOutro();
                }}
              />
              {t("settings.encoding.outro.enabled")}
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void pickOutro()}
              >
                {t("settings.encoding.outro.pick")}
              </Button>
              {outroPath ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={removeOutro}
                >
                  {t("settings.encoding.outro.remove")}
                </Button>
              ) : null}
            </div>

            {!outroPath ? (
              <p className="text-sm text-muted-foreground">
                {t("settings.encoding.outro.noMedia")}
              </p>
            ) : null}

            {draft.outro_enabled && outroPath && !outroProbe.exists ? (
              <p className="text-sm text-destructive">
                {t("settings.encoding.outro.missing")}
              </p>
            ) : null}

            {outroKind === "photo" ? (
              <div className="space-y-1.5">
                <Label>{t("settings.encoding.outro.duration")}</Label>
                <Select
                  value={String(draft.outro_dauer)}
                  onValueChange={(v) => patchNow("outro_dauer", Number(v))}
                  disabled={!draft.outro_enabled}
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
            ) : null}

            {outroKind === "video" && outroProbe.durationSecs != null ? (
              <div className="space-y-1 text-sm">
                <p className="text-muted-foreground">
                  {t("settings.encoding.outro.videoDuration", {
                    secs: outroProbe.durationSecs.toFixed(1),
                  })}
                </p>
                {outroProbe.durationSecs > 10 ? (
                  <p className="text-amber-600 dark:text-amber-500">
                    {t("settings.encoding.outro.longWarning")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </SettingsSection>
      ) : null}
    </div>
  );
}

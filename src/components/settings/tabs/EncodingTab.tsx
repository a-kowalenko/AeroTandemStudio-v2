import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { BodyConcatMode } from "@/lib/tauri";
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

/** Display-normalize aliases to the three Settings select values (parity with Rust). */
function normalizeBodyConcatMode(mode: string | undefined): BodyConcatMode {
  const m = (mode ?? "").trim().toLowerCase();
  if (m === "legacy" || m === "mpegts" || m === "robust") return "legacy";
  if (
    m === "compatible" ||
    m === "compat" ||
    m === "qt_safe" ||
    m === "prepared" ||
    m === "avidemux"
  ) {
    return "compatible";
  }
  return "fast";
}

export function EncodingTab({ draft, patch }: SettingsTabBaseProps) {
  const { t } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="space-y-4">
      <SettingsSection
        title={t("settings.encoding.standard.title")}
        description={t("settings.encoding.standard.description")}
      >
        <div className="space-y-1.5">
          <Label>{t("settings.encoding.codec")}</Label>
          <Select
            value={draft.video_codec}
            onValueChange={(v) => patch("video_codec", v)}
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
            onValueChange={(v) => patch("encoding_strategy", v)}
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

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.hardware_acceleration_enabled}
            onCheckedChange={(v) =>
              patch("hardware_acceleration_enabled", v === true)
            }
          />
          {t("settings.encoding.hwAccel")}
        </label>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.parallel_processing_enabled}
            onCheckedChange={(v) =>
              patch("parallel_processing_enabled", v === true)
            }
          />
          {t("settings.encoding.parallel")}
        </label>

        <div className="space-y-1.5">
          <Label>{t("settings.encoding.concat")}</Label>
          <Select
            value={normalizeBodyConcatMode(draft.body_concat_mode)}
            onValueChange={(v) => patch("body_concat_mode", v)}
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
          <p className="text-xs text-muted-foreground">
            {t("settings.encoding.concatHint")}
          </p>
        </div>
      </SettingsSection>

      <div className="rounded-lg border border-border bg-background/60">
        <Button
          type="button"
          variant="ghost"
          className="flex h-auto w-full items-center justify-between rounded-lg px-3 py-2.5 text-xs font-semibold tracking-wide text-muted uppercase hover:bg-muted/30"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
        >
          {t("settings.encoding.advanced")}
          <ChevronDown
            className={cn(
              "h-4 w-4 transition-transform",
              advancedOpen && "rotate-180",
            )}
            aria-hidden
          />
        </Button>
        {advancedOpen ? (
          <div className="space-y-4 border-t border-border px-3 pt-3 pb-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.intro_enabled}
                onCheckedChange={(v) => patch("intro_enabled", v === true)}
              />
              {t("settings.encoding.introEnabled")}
            </label>
            <div className="space-y-1.5">
              <Label>{t("settings.encoding.introDuration")}</Label>
              <Select
                value={String(draft.dauer)}
                onValueChange={(v) => patch("dauer", Number(v))}
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
                onValueChange={(v) => patch("intro_mux_mode", v)}
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
              <p className="text-xs text-muted-foreground">
                {t("settings.encoding.introMuxHint")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("settings.encoding.previewReuseHint")}
              </p>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.reencode_matching_clips}
                onCheckedChange={(v) =>
                  patch("reencode_matching_clips", v === true)
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
          </div>
        ) : null}
      </div>
    </div>
  );
}

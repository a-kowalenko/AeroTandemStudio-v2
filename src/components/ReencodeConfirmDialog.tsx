import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { EncodeProfile, EncodePresetId } from "@/lib/tauri";
import {
  applyEncodePreset,
  formatAutoCodecOption,
  formatCodecLabel,
} from "@/lib/encodeProfile";

export type ReencodeConfirmChoice = "proceed" | "abort";

export type ReencodeConfirmParams = {
  encoder?: string | null;
  target_codec?: string | null;
  crf?: number | null;
  hw_accel?: boolean | null;
  clip_count?: number | null;
  intro_duration_secs?: number | null;
  intro_mux_mode?: string | null;
  strategy?: string | null;
  degrees?: number | null;
  details?: string[] | null;
};

export type ReencodeConfirmState = {
  kind: string;
  reason: string;
  params: ReencodeConfirmParams;
  recommended: EncodeProfile;
  presets: string[];
};

export type ReencodeConfirmResult =
  | { choice: "abort" }
  | { choice: "proceed"; profile: EncodeProfile };

type Props = {
  open: boolean;
  kind: string;
  reason: string;
  params: ReencodeConfirmParams;
  recommended: EncodeProfile;
  presets?: string[];
  onChoose: (result: ReencodeConfirmResult) => void;
};

function kindLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  kind: string,
): string {
  const key = `dialogs.reencode.kinds.${kind}`;
  const translated = t(key);
  return translated === key ? kind : translated;
}

function presetLabel(t: (key: string) => string, id: string): string {
  const key = `dialogs.reencode.presets.${id}`;
  const translated = t(key);
  return translated === key ? id : translated;
}

/**
 * Compact confirm before re-encode: preset first, details on demand.
 */
export function ReencodeConfirmDialog({
  open,
  kind,
  reason,
  params,
  recommended,
  presets,
  onChoose,
}: Props) {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<EncodeProfile>(recommended);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setProfile(recommended);
      setAdvancedOpen(false);
    }
  }, [open, recommended]);

  const presetIds = useMemo(() => {
    const list = (presets?.length
      ? presets
      : ["recommended", "max_quality", "balanced", "fast", "compat"]) as EncodePresetId[];
    return list;
  }, [presets]);

  const metaBits = useMemo(() => {
    const bits: string[] = [];
    bits.push(kindLabel(t, kind));
    if (params.clip_count != null) {
      bits.push(
        t("dialogs.reencode.clipsShort", { count: params.clip_count }),
      );
    }
    if (params.degrees != null) {
      bits.push(`${params.degrees}°`);
    }
    return bits;
  }, [t, kind, params.clip_count, params.degrees]);

  function onPresetChange(id: string) {
    setProfile(applyEncodePreset(id as EncodePresetId, recommended));
  }

  function patchProfile(partial: Partial<EncodeProfile>) {
    setProfile((prev) => ({
      ...prev,
      ...partial,
      preset_id: "custom",
      recommend_reason: null,
    }));
  }

  const summary = [
    formatCodecLabel(profile),
    `CRF ${profile.crf}`,
    profile.hw_accel
      ? t("dialogs.reencode.hwOn")
      : t("dialogs.reencode.hwOff"),
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onChoose({ choice: "abort" });
      }}
    >
      <DialogContent
        className="max-w-md overflow-hidden border-l-4 border-l-warning"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          onChoose({ choice: "abort" });
        }}
      >
        <DialogHeader className="min-w-0 space-y-1">
          <DialogTitle className="text-warning">
            {t("dialogs.reencode.title")}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0 space-y-3 text-sm text-foreground">
              <p className="text-xs text-muted">
                {metaBits.join(" · ")}
                {reason ? ` — ${reason}` : null}
              </p>

              <div className="space-y-1.5">
                <Label htmlFor="reencode-preset">
                  {t("dialogs.reencode.preset")}
                </Label>
                <Select
                  value={
                    profile.preset_id === "custom"
                      ? "custom"
                      : profile.preset_id
                  }
                  onValueChange={onPresetChange}
                >
                  <SelectTrigger id="reencode-preset">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {presetIds.map((id) => (
                      <SelectItem key={id} value={id}>
                        {presetLabel(t, id)}
                      </SelectItem>
                    ))}
                    {profile.preset_id === "custom" ? (
                      <SelectItem value="custom">
                        {presetLabel(t, "custom")}
                      </SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
              </div>

              {!advancedOpen ? (
                <div className="flex flex-wrap gap-1.5">
                  {summary.map((item) => (
                    <span
                      key={item}
                      className="inline-flex items-center rounded-full border border-border/60 bg-muted/50 px-2.5 py-1 text-xs font-medium text-foreground"
                    >
                      {item}
                    </span>
                  ))}
                </div>
              ) : null}

              <button
                type="button"
                className="text-xs text-muted underline-offset-2 hover:underline"
                onClick={() => setAdvancedOpen((v) => !v)}
              >
                {advancedOpen
                  ? t("dialogs.reencode.hideAdvanced")
                  : t("dialogs.reencode.showAdvanced")}
              </button>

              {advancedOpen ? (
                <div className="grid gap-2.5 rounded-md border border-border/50 p-3">
                  <div className="space-y-1">
                    <Label>{t("dialogs.reencode.paramCodec")}</Label>
                    <Select
                      value={profile.codec}
                      onValueChange={(v) => patchProfile({ codec: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">
                          {formatAutoCodecOption(profile)}
                        </SelectItem>
                        <SelectItem value="h264">H.264</SelectItem>
                        <SelectItem value="h265">H.265</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>{t("dialogs.reencode.paramCrf")}</Label>
                    <Input
                      type="number"
                      min={0}
                      max={51}
                      value={profile.crf}
                      onChange={(e) =>
                        patchProfile({
                          crf: Math.min(
                            51,
                            Math.max(0, Number(e.target.value) || 18),
                          ),
                        })
                      }
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label>{t("dialogs.reencode.swPreset")}</Label>
                      <Select
                        value={profile.sw_preset}
                        onValueChange={(v) => patchProfile({ sw_preset: v })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ultrafast">ultrafast</SelectItem>
                          <SelectItem value="veryfast">veryfast</SelectItem>
                          <SelectItem value="medium">medium</SelectItem>
                          <SelectItem value="slow">slow</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label>{t("dialogs.reencode.nvencPreset")}</Label>
                      <Select
                        value={profile.nvenc_preset}
                        onValueChange={(v) =>
                          patchProfile({ nvenc_preset: v })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="p1">p1</SelectItem>
                          <SelectItem value="p2">p2</SelectItem>
                          <SelectItem value="p4">p4</SelectItem>
                          <SelectItem value="p5">p5</SelectItem>
                          <SelectItem value="p6">p6</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label>{t("dialogs.reencode.scaleMode")}</Label>
                      <Select
                        value={profile.scale_mode}
                        onValueChange={(v) =>
                          patchProfile({
                            scale_mode: v as EncodeProfile["scale_mode"],
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="source">
                            {t("dialogs.reencode.scaleSource")}
                          </SelectItem>
                          <SelectItem value="fit_1080p">
                            {t("dialogs.reencode.scale1080")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label>{t("dialogs.reencode.fpsMode")}</Label>
                      <Select
                        value={profile.fps_mode}
                        onValueChange={(v) =>
                          patchProfile({
                            fps_mode: v as EncodeProfile["fps_mode"],
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="source">
                            {t("dialogs.reencode.fpsSource")}
                          </SelectItem>
                          <SelectItem value="force_30">
                            {t("dialogs.reencode.fps30")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <label className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2 text-sm">
                    <span>{t("settings.encoding.hwAccel")}</span>
                    <Switch
                      checked={profile.hw_accel}
                      onCheckedChange={(v) => patchProfile({ hw_accel: v })}
                    />
                  </label>
                </div>
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 gap-2 sm:justify-between">
          <Button
            variant="outline"
            onClick={() => onChoose({ choice: "abort" })}
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            onClick={() => onChoose({ choice: "proceed", profile })}
          >
            {t("dialogs.reencode.proceed")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

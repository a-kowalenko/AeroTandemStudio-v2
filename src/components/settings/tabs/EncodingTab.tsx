import { useState } from "react";
import { ChevronDown } from "lucide-react";
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
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

export function EncodingTab({ draft, patch }: SettingsTabBaseProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="space-y-4">
      <SettingsSection
        title="Standard"
        description="Empfohlene Einstellungen für die meisten Nutzer."
      >
        <div className="space-y-1.5">
          <Label>Video-Codec</Label>
          <Select
            value={draft.video_codec}
            onValueChange={(v) => patch("video_codec", v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto (empfohlen)</SelectItem>
              <SelectItem value="h264">H.264</SelectItem>
              <SelectItem value="h265">H.265</SelectItem>
              <SelectItem value="vp9">VP9</SelectItem>
              <SelectItem value="av1">AV1</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Encoding-Strategie</Label>
          <Select
            value={draft.encoding_strategy}
            onValueChange={(v) => patch("encoding_strategy", v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="per_clip">Pro Clip</SelectItem>
              <SelectItem value="combined">Kombiniert</SelectItem>
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
          Hardware-Beschleunigung
        </label>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.parallel_processing_enabled}
            onCheckedChange={(v) =>
              patch("parallel_processing_enabled", v === true)
            }
          />
          Paralleles Video-Processing
        </label>

        <div className="space-y-1.5">
          <Label>Clips zusammenfügen</Label>
          <Select
            value={
              draft.body_concat_mode === "fast" ? "fast" : "legacy"
            }
            onValueChange={(v) => patch("body_concat_mode", v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="legacy">Legacy (robust)</SelectItem>
              <SelectItem value="fast">Fast Path (schnell)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Fast Path fügt Clips in einem Durchlauf zusammen (ähnlich Avidemux
            Copy). Bei Fehlern erscheint eine Auswahl: Abbrechen oder Legacy.
            Legacy nutzt die bewährte MPEG-TS-Pipeline.
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
          Erweitert
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
              Intro beim Erstellen verwenden (experimentell)
            </label>
            <div className="space-y-1.5">
              <Label>Intro-Dauer (Sek.)</Label>
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
              <Label>Intro zusammenfügen</Label>
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
                    Neu kodieren (kompatibel)
                  </SelectItem>
                  <SelectItem value="stream_copy">
                    Stream-Copy (schnell)
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Neu kodieren erzeugt Intro und Flugvideo als einen durchgängigen
                Bitstream — zuverlässig auf Handys und in Playern. Stream-Copy
                ist schneller, kann aber auf manchen Geräten einfrieren.
              </p>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.reencode_matching_clips}
                onCheckedChange={(v) =>
                  patch("reencode_matching_clips", v === true)
                }
              />
              Passende Clips neu encodieren
            </label>

            <div className="space-y-1.5">
              <Label>Preview CRF</Label>
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

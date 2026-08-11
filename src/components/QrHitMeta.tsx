import {
  Camera,
  type LucideIcon,
  Mountain,
  Smartphone,
  Video,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type QrHitMedia = {
  mode: "handcam" | "outside" | "";
  foto: boolean;
  video: boolean;
};

export type QrHitMetaProps = {
  fileName?: string | null;
  displayName?: string | null;
  customerHash?: string | null;
  bookingHash?: string | null;
  media?: QrHitMedia | null;
  className?: string;
};

type MediaChip = {
  key: string;
  label: string;
  kind: "mode" | "product";
  icon: LucideIcon;
};

function mediaChips(media: QrHitMedia): MediaChip[] {
  const chips: MediaChip[] = [];
  if (media.mode === "handcam") {
    chips.push({
      key: "mode",
      label: "Handcam",
      kind: "mode",
      icon: Smartphone,
    });
  } else if (media.mode === "outside") {
    chips.push({
      key: "mode",
      label: "Outside",
      kind: "mode",
      icon: Mountain,
    });
  }
  if (media.foto) {
    chips.push({ key: "foto", label: "Foto", kind: "product", icon: Camera });
  }
  if (media.video) {
    chips.push({ key: "video", label: "Video", kind: "product", icon: Video });
  }
  return chips;
}

function MediaChipView({ chip }: { chip: MediaChip }) {
  const Icon = chip.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold tracking-wide",
        chip.kind === "mode"
          ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/25"
          : "bg-background/80 text-foreground/90 ring-1 ring-inset ring-border/80",
      )}
    >
      <Icon className="h-3 w-3 shrink-0 opacity-80" aria-hidden />
      {chip.label}
    </span>
  );
}

function HashRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium tracking-wide text-muted uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 break-all font-mono text-xs leading-snug text-foreground/90 [overflow-wrap:anywhere]">
        {value}
      </dd>
    </div>
  );
}

/** Compact QR payload summary tile (name, media, file, hashes). */
export function QrHitMeta({
  fileName,
  displayName,
  customerHash,
  bookingHash,
  media,
  className,
}: QrHitMetaProps) {
  const name = displayName?.trim() || "";
  const file = fileName?.trim() || "";
  const customer = customerHash?.trim() || "";
  const booking = bookingHash?.trim() || "";
  const chips = media ? mediaChips(media) : [];

  if (!name && !file && !customer && !booking && chips.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "min-w-0 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5",
        className,
      )}
    >
      {(name || chips.length > 0) && (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          {name ? (
            <p className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">
              {name}
            </p>
          ) : (
            <span />
          )}
          {chips.length > 0 ? (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {chips.map((chip) => (
                <MediaChipView key={chip.key} chip={chip} />
              ))}
            </div>
          ) : null}
        </div>
      )}

      {file ? (
        <p
          className={cn(
            "truncate text-sm text-muted",
            (name || chips.length > 0) && "mt-1",
          )}
          title={file}
        >
          {file}
        </p>
      ) : null}

      {(customer || booking) && (
        <dl
          className={cn(
            "grid min-w-0 gap-2",
            (name || chips.length > 0 || file) && "mt-2 border-t border-border/50 pt-2",
            customer && booking ? "sm:grid-cols-2" : "grid-cols-1",
          )}
        >
          {customer ? <HashRow label="Customer" value={customer} /> : null}
          {booking ? <HashRow label="Booking" value={booking} /> : null}
        </dl>
      )}
    </div>
  );
}

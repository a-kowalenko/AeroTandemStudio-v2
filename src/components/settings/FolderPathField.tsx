import { ExternalLink, FolderOpen } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
  label: string;
  value: string;
  onPick: () => void;
  onOpenError: (message: string) => void;
  placeholder?: string;
  disabled?: boolean;
};

export function FolderPathField({
  label,
  value,
  onPick,
  onOpenError,
  placeholder = "Ordner wählen…",
  disabled = false,
}: Props) {
  const canOpen = Boolean(value.trim()) && !disabled;

  async function openFolder() {
    const path = value.trim();
    if (!path) {
      onOpenError("Kein Ordner gesetzt.");
      return;
    }
    try {
      await revealItemInDir(path);
    } catch (e) {
      onOpenError(String(e));
    }
  }

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="relative">
        <Input
          value={value}
          readOnly
          disabled={disabled}
          placeholder={placeholder}
          className="pr-[4.5rem]"
        />
        <button
          type="button"
          onClick={() => void openFolder()}
          disabled={!canOpen}
          title="Ordner im Explorer öffnen"
          aria-label="Ordner im Explorer öffnen"
          className={cn(
            "absolute top-1/2 right-9 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted transition-colors",
            "hover:bg-primary-soft hover:text-foreground",
            "disabled:pointer-events-none disabled:opacity-40",
          )}
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onPick}
          disabled={disabled}
          title="Ordner wählen"
          aria-label="Ordner wählen"
          className={cn(
            "absolute top-1/2 right-1 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted transition-colors",
            "hover:bg-primary-soft hover:text-foreground",
            "disabled:pointer-events-none disabled:opacity-40",
          )}
        >
          <FolderOpen className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}

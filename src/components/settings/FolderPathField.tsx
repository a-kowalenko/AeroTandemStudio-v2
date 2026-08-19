import { ExternalLink, FolderOpen } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
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
  placeholder,
  disabled = false,
}: Props) {
  const { t } = useTranslation();
  const folderPlaceholder = placeholder ?? t("settings.folder.placeholder");
  const canOpen = Boolean(value.trim()) && !disabled;

  async function openFolder() {
    const path = value.trim();
    if (!path) {
      onOpenError(t("settings.folder.noneSet"));
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
          placeholder={folderPlaceholder}
          className="pr-[4.5rem]"
        />
        <button
          type="button"
          onClick={() => void openFolder()}
          disabled={!canOpen}
          title={t("settings.folder.openInExplorer")}
          aria-label={t("settings.folder.openInExplorer")}
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
          title={t("common.actions.pickFolder")}
          aria-label={t("common.actions.pickFolder")}
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

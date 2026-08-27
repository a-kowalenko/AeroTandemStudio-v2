import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

const ROW_TEXT = "text-xs leading-5";
const LABEL_COL = "w-[4.25rem] shrink-0";
const SUBLABEL_COL = "w-[4.25rem] shrink-0 text-muted";

function PathHintUrl({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cn("min-w-0 break-all font-mono", ROW_TEXT, className)}>
      {value}
    </span>
  );
}

function PathHintSuggestRow({ label, url }: { label: string; url: string }) {
  return (
    <div className={cn("flex items-start gap-3", ROW_TEXT)}>
      <dt className={cn(LABEL_COL, "font-medium text-foreground")}>{label}</dt>
      <dd className="min-w-0 flex-1">
        <PathHintUrl value={url} className="text-muted" />
      </dd>
    </div>
  );
}

export function PathHintsSuggestList({
  primary,
  backup,
}: {
  primary: string;
  backup?: string | null;
}) {
  const { t } = useTranslation();
  return (
    <dl className="space-y-1">
      <PathHintSuggestRow
        label={t("settings.server.pathHints.primaryLabel")}
        url={primary}
      />
      {backup?.trim() ? (
        <PathHintSuggestRow
          label={t("settings.server.pathHints.backupLabel")}
          url={backup}
        />
      ) : null}
    </dl>
  );
}

function PathHintDriftRow({
  label,
  current,
  suggested,
  currentLabel,
  suggestedLabel,
}: {
  label: string;
  current: string;
  suggested: string;
  currentLabel: string;
  suggestedLabel: string;
}) {
  return (
    <div className={cn("flex items-start gap-3", ROW_TEXT)}>
      <dt className={cn(LABEL_COL, "font-medium text-foreground")}>{label}</dt>
      <dd className="min-w-0 flex-1 space-y-1">
        <div className="flex items-start gap-2">
          <span className={SUBLABEL_COL}>{currentLabel}</span>
          <PathHintUrl
            value={current}
            className="min-w-0 flex-1 text-muted line-through decoration-muted/60"
          />
        </div>
        <div className="flex items-start gap-2">
          <span className={cn(SUBLABEL_COL, "font-medium text-foreground")}>
            {suggestedLabel}
          </span>
          <PathHintUrl value={suggested} className="min-w-0 flex-1 text-foreground" />
        </div>
      </dd>
    </div>
  );
}

export function PathHintsDriftList({
  primary,
  backup,
}: {
  primary?: { current: string; suggested: string } | null;
  backup?: { current: string; suggested: string } | null;
}) {
  const { t } = useTranslation();
  if (!primary && !backup) return null;
  const currentLabel = t("settings.server.pathHints.driftCurrentLabel");
  const suggestedLabel = t("settings.server.pathHints.driftSuggestedLabel");
  return (
    <dl className="space-y-1">
      {primary ? (
        <PathHintDriftRow
          label={t("settings.server.pathHints.primaryLabel")}
          current={primary.current}
          suggested={primary.suggested}
          currentLabel={currentLabel}
          suggestedLabel={suggestedLabel}
        />
      ) : null}
      {backup ? (
        <PathHintDriftRow
          label={t("settings.server.pathHints.backupLabel")}
          current={backup.current}
          suggested={backup.suggested}
          currentLabel={currentLabel}
          suggestedLabel={suggestedLabel}
        />
      ) : null}
    </dl>
  );
}

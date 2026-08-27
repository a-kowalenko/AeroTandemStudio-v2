import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  useHeaderBrandCollapse,
  type HeaderBrandCollapse,
  type HeaderSubtitleLevel,
} from "@/hooks/useHeaderBrandCollapse";
import {
  buildHeaderSubtitleFull,
  resolveHeaderSubtitleText,
} from "@/hooks/headerBrandText";
import { cn } from "@/lib/utils";

const APP_TITLE_FULL = "Aero Tandem Studio";
const APP_TITLE_SHORT = "ATS";

const ROW1_CLASS = "flex min-w-0 max-w-full items-baseline gap-x-1.5 overflow-hidden";
const TITLE_CLASS =
  "font-display text-base font-semibold leading-none tracking-tight text-primary whitespace-nowrap";
const VERSION_CLASS = "shrink-0 text-[11px] leading-none text-muted whitespace-nowrap";
const ROW2_CLASS = "min-w-0 max-w-full text-[10px] leading-none text-muted whitespace-nowrap overflow-hidden";

type Props = {
  appVersion: string;
  ready: boolean;
  hwLabel: string | null;
  className?: string;
};

function titleForLevel(level: HeaderBrandCollapse["title"]): string {
  if (level === 0) return APP_TITLE_FULL;
  if (level <= 2) return APP_TITLE_SHORT;
  return "";
}

function showVersionForLevel(level: HeaderBrandCollapse["title"]): boolean {
  return level === 0 || level === 1;
}

export function HeaderBrand({
  appVersion,
  ready,
  hwLabel,
  className,
}: Props) {
  const { t } = useTranslation();
  const measureRef = useRef<HTMLDivElement>(null);
  const row1Ref = useRef<HTMLDivElement>(null);
  const row2Ref = useRef<HTMLParagraphElement>(null);
  const probeRow1Ref = useRef<HTMLDivElement>(null);
  const probeRow2Ref = useRef<HTMLParagraphElement>(null);

  const subtitleSource = useMemo(
    () => ({ ready, hwLabel }),
    [ready, hwLabel],
  );

  const subtitleFull = useMemo(
    () => buildHeaderSubtitleFull(t, subtitleSource),
    [t, subtitleSource],
  );

  const applyProbeStep = useCallback(
    (step: HeaderBrandCollapse) => {
      const row1 = probeRow1Ref.current;
      const row2 = probeRow2Ref.current;
      if (!row1 || !row2) return;

      const titleEl = row1.querySelector<HTMLElement>('[data-probe-part="title"]');
      const versionEl = row1.querySelector<HTMLElement>('[data-probe-part="version"]');
      if (!titleEl || !versionEl) return;

      if (step.title >= 3) {
        titleEl.textContent = "";
        versionEl.textContent = "";
        versionEl.hidden = true;
      } else {
        titleEl.textContent = titleForLevel(step.title);
        const showVersion = showVersionForLevel(step.title);
        versionEl.hidden = !showVersion;
        versionEl.textContent = showVersion ? `v${appVersion}` : "";
      }

      const subtitle = resolveHeaderSubtitleText(
        step.subtitle as HeaderSubtitleLevel,
        t,
        subtitleSource,
      );
      row2.textContent = subtitle ?? "";
      row2.hidden = step.subtitle >= 2;
    },
    [appVersion, subtitleSource, t],
  );

  const { collapse } = useHeaderBrandCollapse({
    measureKey: `${appVersion}|${ready}|${hwLabel ?? ""}|${subtitleFull}`,
    measureRef,
    probeRow1Ref,
    probeRow2Ref,
    applyProbeStep,
  });

  const showTitle = collapse.title < 3;
  const showVersion = showVersionForLevel(collapse.title);
  const titleText = titleForLevel(collapse.title);

  const subtitleText = resolveHeaderSubtitleText(
    collapse.subtitle,
    t,
    subtitleSource,
  );
  const showSubtitle = subtitleText != null;

  const brandTooltip = useMemo(() => {
    const parts = [APP_TITLE_FULL, `v${appVersion}`];
    if (subtitleFull) parts.push(subtitleFull);
    return parts.join(" · ");
  }, [appVersion, subtitleFull]);

  const collapsedToLogoOnly = !showTitle && !showSubtitle;

  return (
    <div
      className={cn(
        "pointer-events-none flex min-w-0 flex-1 items-center gap-2.5",
        className,
      )}
      title={collapsedToLogoOnly ? brandTooltip : undefined}
    >
      <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-primary-soft ring-1 ring-primary/20">
        <img
          src="/logo.png"
          alt=""
          className="h-[22px] w-[22px] object-contain"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      </div>
      <div ref={measureRef} className="relative min-h-[34px] min-w-0 flex-1">
        <div className="flex min-h-[34px] min-w-0 flex-col justify-center gap-0.5">
          {showTitle ? (
            <div ref={row1Ref} className={ROW1_CLASS}>
              <h1
                className={TITLE_CLASS}
                title={titleText !== APP_TITLE_FULL ? APP_TITLE_FULL : undefined}
                aria-label={APP_TITLE_FULL}
              >
                {titleText}
              </h1>
              {showVersion ? (
                <span className={VERSION_CLASS}>v{appVersion}</span>
              ) : null}
            </div>
          ) : null}
          {showSubtitle ? (
            <p
              ref={row2Ref}
              className={ROW2_CLASS}
              title={subtitleText !== subtitleFull ? subtitleFull : undefined}
            >
              {subtitleText}
            </p>
          ) : null}
        </div>

        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex flex-col justify-center gap-0.5 overflow-hidden opacity-0"
        >
          <div ref={probeRow1Ref} className={ROW1_CLASS}>
            <h1 data-probe-part="title" className={TITLE_CLASS} />
            <span data-probe-part="version" className={VERSION_CLASS} hidden />
          </div>
          <p ref={probeRow2Ref} className={ROW2_CLASS} />
        </div>
      </div>
    </div>
  );
}

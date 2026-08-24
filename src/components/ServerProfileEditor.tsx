import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import type { AppConfig } from "@/lib/tauri";
import {
  createServerProfile,
  deleteServerProfile,
  displayServerProfileLabel,
  displayServerProfileSubtitle,
  getActiveServerProfile,
  patchActiveServerProfileLabel,
  patchServerConnection,
  serverUrlToDialogDefaultPath,
  switchServerProfile,
} from "@/lib/serverProfile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { serverGuestHint } from "@/lib/serverStatus";
import { cn } from "@/lib/utils";

type Props = {
  draft: AppConfig;
  setDraft: (next: AppConfig) => void;
  disabled?: boolean;
  onError?: (message: string, title?: string) => void;
  errorTitle?: string;
  flashFocus?: "server-url" | "server-credentials" | null;
  urlInputRef?: RefObject<HTMLInputElement | null>;
  loginInputRef?: RefObject<HTMLInputElement | null>;
  urlSectionRef?: RefObject<HTMLDivElement | null>;
  credentialsSectionRef?: RefObject<HTMLDivElement | null>;
  footer?: ReactNode;
  listZIndex?: number;
};

export function ServerProfileEditor({
  draft,
  setDraft,
  disabled = false,
  onError,
  errorTitle,
  flashFocus = null,
  urlInputRef,
  loginInputRef,
  urlSectionRef,
  credentialsSectionRef,
  footer,
}: Props) {
  const { t } = useTranslation();
  const profiles = draft.server_profiles ?? [];
  const active = getActiveServerProfile(draft);
  const activeId = draft.active_server_profile_id;
  const canDelete = profiles.length > 1;
  const focusNameOnProfileRef = useRef<string | null>(null);
  const profileNameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!focusNameOnProfileRef.current) return;
    if (focusNameOnProfileRef.current !== activeId) return;
    focusNameOnProfileRef.current = null;
    window.setTimeout(() => {
      profileNameInputRef.current?.focus({ preventScroll: true });
      profileNameInputRef.current?.select();
    }, 0);
  }, [activeId]);

  async function pickServerPath() {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: serverUrlToDialogDefaultPath(draft.server_url),
      });
      if (typeof selected === "string") {
        const next = selected.trim();
        if (!next) return;
        setDraft(patchServerConnection(draft, { url: next }));
      }
    } catch (err) {
      onError?.(String(err), errorTitle);
    }
  }

  function onAddProfile() {
    const next = createServerProfile(
      draft,
      t("settings.server.smb.newProfileDefault"),
    );
    focusNameOnProfileRef.current = next.active_server_profile_id;
    setDraft(next);
  }

  function onDeleteProfile(profileId: string) {
    const next = deleteServerProfile(draft, profileId);
    if (!next) {
      onError?.(
        t("settings.server.smb.cannotDeleteLast"),
        errorTitle,
      );
      return;
    }
    setDraft(next);
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">
              {t("settings.server.smb.profileListTitle")}
            </p>
            <p className="text-[11px] text-muted">
              {t("settings.server.smb.profileListHint")}
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={onAddProfile}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t("settings.server.smb.addProfile")}
          </Button>
        </div>

        <ul className="space-y-1.5" role="listbox" aria-label={t("settings.server.smb.profileListTitle")}>
          {profiles.map((profile) => {
            const isActive = profile.id === activeId;
            const subtitle = displayServerProfileSubtitle(profile);
            return (
              <li key={profile.id}>
                <div
                  className={cn(
                    "flex items-stretch overflow-hidden rounded-lg border transition-colors",
                    isActive
                      ? "border-primary/60 bg-primary-soft/25"
                      : "border-border bg-background/40",
                  )}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    disabled={disabled}
                    onClick={() => setDraft(switchServerProfile(draft, profile.id))}
                    className={cn(
                      "min-w-0 flex-1 px-3 py-2.5 text-left transition-colors",
                      !isActive && !disabled && "hover:bg-muted/30",
                      disabled && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <p className="truncate text-sm font-medium">
                      {displayServerProfileLabel(profile)}
                    </p>
                    <p className="truncate text-[11px] text-muted">
                      {subtitle || t("settings.server.smb.profileNoUrl")}
                    </p>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled || !canDelete}
                    className="h-auto shrink-0 rounded-none border-l border-border/60 px-2.5"
                    title={t("settings.server.smb.deleteProfile")}
                    aria-label={t("settings.server.smb.deleteProfileNamed", {
                      name: displayServerProfileLabel(profile),
                    })}
                    onClick={() => onDeleteProfile(profile.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-3 rounded-xl border border-border/60 bg-background/30 p-3">
        <div>
          <p className="text-sm font-medium">
            {t("settings.server.smb.profileEditTitle")}
          </p>
          <p className="text-[11px] text-muted">
            {active
              ? t("settings.server.smb.profileEditHint", {
                  name: displayServerProfileLabel(active),
                })
              : t("settings.server.smb.profileEditHintGeneric")}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="server-profile-name">
            {t("settings.server.smb.profileLabel")}
          </Label>
          <Input
            id="server-profile-name"
            ref={profileNameInputRef}
            disabled={disabled}
            value={active?.label ?? ""}
            onChange={(e) =>
              setDraft(patchActiveServerProfileLabel(draft, e.target.value))
            }
            placeholder={t("settings.server.smb.profileLabelPlaceholder")}
          />
        </div>

        <div
          ref={urlSectionRef}
          className="relative space-y-1.5 rounded-xl p-2.5"
        >
          {flashFocus === "server-url" ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-xl ats-settings-focus-flash"
            />
          ) : null}
          <Label htmlFor="server-profile-url" className="relative">
            {t("settings.server.smb.url")}
          </Label>
          <div className="relative">
            <Input
              id="server-profile-url"
              ref={urlInputRef}
              disabled={disabled}
              className="pr-10"
              value={draft.server_url}
              onChange={(e) =>
                setDraft(patchServerConnection(draft, { url: e.target.value }))
              }
              placeholder={t("settings.server.smb.urlPlaceholder")}
            />
            <button
              type="button"
              disabled={disabled}
              onClick={() => void pickServerPath()}
              title={t("common.actions.pickFolder")}
              aria-label={t("common.actions.pickFolder")}
              className="absolute top-1/2 right-1 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted transition-colors hover:bg-primary-soft hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <FolderOpen className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>

        <div
          ref={credentialsSectionRef}
          className="relative rounded-xl p-2.5"
        >
          {flashFocus === "server-credentials" ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-xl ats-settings-focus-flash"
            />
          ) : null}
          <div className="relative grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="server-profile-login">
                {t("settings.server.smb.login")}
              </Label>
              <Input
                id="server-profile-login"
                ref={loginInputRef}
                disabled={disabled}
                value={draft.server_login}
                onChange={(e) =>
                  setDraft(
                    patchServerConnection(draft, { login: e.target.value }),
                  )
                }
                autoComplete="username"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="server-profile-password">
                {t("settings.server.smb.password")}
              </Label>
              <PasswordInput
                id="server-profile-password"
                disabled={disabled}
                value={draft.server_password}
                onChange={(e) =>
                  setDraft(
                    patchServerConnection(draft, {
                      password: e.target.value,
                    }),
                  )
                }
                autoComplete="current-password"
              />
            </div>
          </div>
        </div>

        <p className="text-[11px] text-muted">{serverGuestHint()}</p>

        {footer ? <div className="pt-1">{footer}</div> : null}
      </div>
    </div>
  );
}

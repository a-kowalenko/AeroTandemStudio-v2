import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import type { AppConfig } from "@/lib/tauri";
import {
  composeServerUrl,
  createServerProfile,
  deleteServerProfile,
  displayServerProfileLabel,
  displayServerProfileSubtitle,
  findServerProfile,
  getActiveServerProfile,
  parseServerUrlParts,
  patchActiveServerProfileBackup,
  patchActiveServerProfileLabel,
  patchServerConnection,
  pushFlatToActiveProfile,
  SERVER_URL_SCHEME_OPTIONS,
  serverUrlToDialogDefaultPath,
  switchServerProfile,
  type ServerUrlScheme,
} from "@/lib/serverProfile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { ServerUrlSchemePicker } from "@/components/ServerUrlSchemePicker";
import { serverGuestHint } from "@/lib/serverStatus";
import { cn } from "@/lib/utils";

type EditorMode = {
  profileId: string;
  created?: boolean;
};

type Props = {
  draft: AppConfig;
  setDraft: (next: AppConfig) => void;
  disabled?: boolean;
  /** Settings: full list + collapsed editor. Wizard: compact when only one profile. */
  variant?: "settings" | "wizard";
  onError?: (message: string, title?: string) => void;
  errorTitle?: string;
  flashFocus?: "server-url" | "server-credentials" | "server-backup-url" | null;
  urlInputRef?: RefObject<HTMLInputElement | null>;
  loginInputRef?: RefObject<HTMLInputElement | null>;
  backupUrlInputRef?: RefObject<HTMLInputElement | null>;
  urlSectionRef?: RefObject<HTMLDivElement | null>;
  credentialsSectionRef?: RefObject<HTMLDivElement | null>;
  backupUrlSectionRef?: RefObject<HTMLDivElement | null>;
  footer?: ReactNode;
  /** Fired when create/edit panel opens or closes (settings banners). */
  onEditingChange?: (editing: boolean) => void;
};

export function ServerProfileEditor({
  draft,
  setDraft,
  disabled = false,
  variant = "settings",
  onError,
  errorTitle,
  flashFocus = null,
  urlInputRef,
  loginInputRef,
  backupUrlInputRef,
  urlSectionRef,
  credentialsSectionRef,
  backupUrlSectionRef,
  footer,
  onEditingChange,
}: Props) {
  const { t } = useTranslation();
  const profiles = draft.server_profiles ?? [];
  const active = getActiveServerProfile(draft);
  const activeId = draft.active_server_profile_id;
  const canDelete = profiles.length > 1;
  const singleWizardProfile = variant === "wizard" && profiles.length <= 1;
  const wizardExpandedEditor = variant === "wizard";
  const showList = variant !== "wizard" || profiles.length > 1;

  const [editorMode, setEditorMode] = useState<EditorMode | null>(null);
  const wizardAutoOpenedRef = useRef(false);
  const focusNameOnProfileRef = useRef<string | null>(null);
  const profileNameInputRef = useRef<HTMLInputElement | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const editorOpen = editorMode !== null;
  const editingProfile = editorMode
    ? findServerProfile(profiles, editorMode.profileId)
    : undefined;

  /** Avoid stale closures overwriting URL/login while typing. */
  function replaceDraft(next: AppConfig) {
    draftRef.current = next;
    setDraft(next);
  }

  function updateDraft(updater: (prev: AppConfig) => AppConfig) {
    replaceDraft(updater(draftRef.current));
  }

  useEffect(() => {
    onEditingChange?.(editorOpen || singleWizardProfile);
  }, [editorOpen, singleWizardProfile, onEditingChange]);

  useEffect(() => {
    if (!flashFocus || !activeId) return;
    setEditorMode({ profileId: activeId });
  }, [flashFocus, activeId]);

  useEffect(() => {
    if (variant !== "wizard" || !activeId) return;
    if (singleWizardProfile) {
      if (editorMode?.profileId !== activeId) {
        setEditorMode({ profileId: activeId });
      }
      return;
    }
    if (wizardAutoOpenedRef.current) return;
    if (!draft.server_url.trim()) {
      wizardAutoOpenedRef.current = true;
      setEditorMode({ profileId: activeId });
    }
  }, [
    variant,
    singleWizardProfile,
    draft.server_url,
    activeId,
    editorMode?.profileId,
  ]);

  useEffect(() => {
    if (!focusNameOnProfileRef.current) return;
    if (focusNameOnProfileRef.current !== editorMode?.profileId) return;
    focusNameOnProfileRef.current = null;
    window.setTimeout(() => {
      profileNameInputRef.current?.focus({ preventScroll: true });
      profileNameInputRef.current?.select();
    }, 0);
  }, [editorMode?.profileId]);

  function closeEditor(save: boolean) {
    if (singleWizardProfile) {
      if (save) updateDraft((prev) => pushFlatToActiveProfile(prev));
      return;
    }
    if (save) {
      updateDraft((prev) => pushFlatToActiveProfile(prev));
    }
    setEditorMode(null);
  }

  async function pickServerPath(target: "primary" | "backup" = "primary") {
    try {
      const current = draftRef.current;
      const currentUrl =
        target === "backup"
          ? (getActiveServerProfile(current)?.backup_url ?? "")
          : current.server_url;
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: serverUrlToDialogDefaultPath(currentUrl),
      });
      if (typeof selected === "string") {
        const next = selected.trim();
        if (!next) return;
        if (target === "backup") {
          updateDraft((prev) =>
            patchActiveServerProfileBackup(prev, { backup_url: next }),
          );
        } else {
          updateDraft((prev) => patchServerConnection(prev, { url: next }));
        }
      }
    } catch (err) {
      onError?.(String(err), errorTitle);
    }
  }

  function prepareDraftForProfileChange(): AppConfig {
    const current = draftRef.current;
    if (!editorOpen && !wizardExpandedEditor) return current;
    return pushFlatToActiveProfile(current);
  }

  function onSelectProfile(profileId: string) {
    if (disabled) return;
    let next = prepareDraftForProfileChange();
    if (editorOpen) setEditorMode(null);
    if (profileId !== next.active_server_profile_id) {
      next = switchServerProfile(next, profileId);
    }
    replaceDraft(next);
  }

  function onEditProfile(profileId: string) {
    if (disabled) return;
    let next = prepareDraftForProfileChange();
    next = switchServerProfile(next, profileId);
    replaceDraft(next);
    setEditorMode({ profileId });
  }

  function onAddProfile() {
    if (disabled) return;
    const next = createServerProfile(
      prepareDraftForProfileChange(),
      t("settings.server.smb.newProfileDefault"),
    );
    focusNameOnProfileRef.current = next.active_server_profile_id;
    replaceDraft(next);
    setEditorMode({
      profileId: next.active_server_profile_id,
      created: true,
    });
  }

  function onDeleteProfile(profileId: string) {
    const profile = findServerProfile(profiles, profileId);
    if (profile) {
      const hasData =
        profile.url.trim() ||
        profile.login.trim() ||
        profile.password.trim();
      if (
        hasData &&
        !window.confirm(
          t("settings.server.smb.deleteProfileConfirm", {
            name: displayServerProfileLabel(profile),
          }),
        )
      ) {
        return;
      }
    }

    const next = deleteServerProfile(prepareDraftForProfileChange(), profileId);
    if (!next) {
      onError?.(
        t("settings.server.smb.cannotDeleteLast"),
        errorTitle,
      );
      return;
    }
    if (editorMode?.profileId === profileId) {
      setEditorMode(null);
    }
    replaceDraft(next);
  }

  function renderProfileRow(profile: (typeof profiles)[number]) {
    const isActive = profile.id === activeId;
    const isEditing = editorMode?.profileId === profile.id;
    const subtitle = displayServerProfileSubtitle(profile);

    return (
      <li key={profile.id}>
        <div
          className={cn(
            "flex items-stretch overflow-hidden rounded-lg border transition-colors",
            isActive
              ? "border-primary/60 bg-primary-soft/25"
              : "border-border bg-background/40",
            isEditing && editorOpen && "ring-1 ring-primary/40",
          )}
        >
          <button
            type="button"
            role="option"
            aria-selected={isActive}
            disabled={disabled}
            onClick={() => onSelectProfile(profile.id)}
            className={cn(
              "flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5 text-left transition-colors",
              !isActive && !disabled && "hover:bg-muted/30",
              disabled && "cursor-not-allowed opacity-60",
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                isActive
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-muted-foreground/40",
              )}
              aria-hidden
            >
              {isActive ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {displayServerProfileLabel(profile)}
              </p>
              <p className="truncate text-[11px] text-muted">
                {subtitle || t("settings.server.smb.profileNoUrl")}
              </p>
            </span>
          </button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            className="h-auto shrink-0 rounded-none border-l border-border/60 px-2.5"
            title={t("settings.server.smb.editProfile")}
            aria-label={t("settings.server.smb.editProfileNamed", {
              name: displayServerProfileLabel(profile),
            })}
            onClick={() => onEditProfile(profile.id)}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </Button>
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
  }

  function renderEditorForm() {
    const formProfile = wizardExpandedEditor || singleWizardProfile
      ? active
      : editingProfile;
    const formOpen = wizardExpandedEditor
      ? Boolean(active)
      : singleWizardProfile
        ? Boolean(active)
        : editorOpen;
    if (!formOpen || !formProfile) return null;

    const { scheme, rest } = parseServerUrlParts(draft.server_url);
    const schemeLabel = (id: ServerUrlScheme) =>
      id === "path"
        ? t("settings.server.smb.schemePath")
        : (SERVER_URL_SCHEME_OPTIONS.find((o) => o.id === id)?.prefix ?? id);
    const restPlaceholder =
      scheme === "\\\\"
        ? t("settings.server.smb.urlPlaceholderUnc")
        : scheme === "path"
          ? t("settings.server.smb.urlPlaceholderPath")
          : t("settings.server.smb.urlPlaceholderHost");

    return (
      <div className="space-y-3 rounded-xl border border-primary/30 bg-background/40 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {editorMode?.created
                ? t("settings.server.smb.profileCreateTitle")
                : t("settings.server.smb.profileEditTitleNamed", {
                    name: displayServerProfileLabel(formProfile),
                  })}
            </p>
            <p className="text-[11px] text-muted">
              {wizardExpandedEditor || singleWizardProfile
                ? t("settings.server.smb.profileWizardHint")
                : t("settings.server.smb.profileEditPanelHint")}
            </p>
          </div>
          {!singleWizardProfile && !wizardExpandedEditor ? (
            <div className="flex shrink-0 gap-1.5">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={disabled}
                onClick={() => closeEditor(true)}
              >
                {t("common.actions.done")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => closeEditor(true)}
              >
                {t("common.actions.cancel")}
              </Button>
            </div>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="server-profile-name">
            {t("settings.server.smb.profileLabel")}
          </Label>
          <Input
            id="server-profile-name"
            ref={profileNameInputRef}
            disabled={disabled}
            value={formProfile.label}
            onChange={(e) =>
              updateDraft((prev) =>
                patchActiveServerProfileLabel(prev, e.target.value),
              )
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
          <div
            className={cn(
              "flex rounded-md border border-border bg-card shadow-sm",
              "focus-within:ring-2 focus-within:ring-ring",
              disabled && "opacity-50",
            )}
          >
            <ServerUrlSchemePicker
              value={scheme}
              disabled={disabled}
              aria-label={t("settings.server.smb.scheme")}
              labelFor={schemeLabel}
              listZIndex={variant === "wizard" ? 200 : 80}
              onChange={(nextScheme) =>
                updateDraft((prev) => {
                  const parts = parseServerUrlParts(prev.server_url);
                  return patchServerConnection(prev, {
                    url: composeServerUrl(nextScheme, parts.rest),
                  });
                })
              }
            />
            <div className="relative min-w-0 flex-1">
              <Input
                id="server-profile-url"
                ref={urlInputRef}
                disabled={disabled}
                className="h-9 rounded-none rounded-r-md border-0 pr-10 shadow-none focus-visible:ring-0"
                value={rest}
                onChange={(e) =>
                  updateDraft((prev) => {
                    const parts = parseServerUrlParts(prev.server_url);
                    return patchServerConnection(prev, {
                      url: composeServerUrl(parts.scheme, e.target.value),
                    });
                  })
                }
                placeholder={restPlaceholder}
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => void pickServerPath("primary")}
                title={t("common.actions.pickFolder")}
                aria-label={t("common.actions.pickFolder")}
                className="absolute top-1/2 right-1 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted transition-colors hover:bg-primary-soft hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
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
                  updateDraft((prev) =>
                    patchServerConnection(prev, { login: e.target.value }),
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
                  updateDraft((prev) =>
                    patchServerConnection(prev, {
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

        {(() => {
          const backupParts = parseServerUrlParts(formProfile.backup_url ?? "");
          const backupRestPlaceholder =
            backupParts.scheme === "\\\\"
              ? t("settings.server.smb.urlPlaceholderUnc")
              : backupParts.scheme === "path"
                ? t("settings.server.smb.urlPlaceholderPath")
                : t("settings.server.smb.urlPlaceholderHost");
          return (
            <div
              ref={backupUrlSectionRef}
              className="relative space-y-1.5 rounded-xl p-2.5"
            >
              {flashFocus === "server-backup-url" ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-xl ats-settings-focus-flash"
                />
              ) : null}
              <Label htmlFor="server-profile-backup-url" className="relative">
                {t("settings.server.smb.backupUrl")}
              </Label>
              <div
                className={cn(
                  "flex rounded-md border border-border bg-card shadow-sm",
                  "focus-within:ring-2 focus-within:ring-ring",
                  disabled && "opacity-50",
                )}
              >
                <ServerUrlSchemePicker
                  value={backupParts.scheme}
                  disabled={disabled}
                  aria-label={t("settings.server.smb.scheme")}
                  labelFor={schemeLabel}
                  listZIndex={variant === "wizard" ? 200 : 80}
                  onChange={(nextScheme) =>
                    updateDraft((prev) => {
                      const profile = getActiveServerProfile(prev);
                      const parts = parseServerUrlParts(
                        profile?.backup_url ?? "",
                      );
                      return patchActiveServerProfileBackup(prev, {
                        backup_url: composeServerUrl(
                          nextScheme,
                          parts.rest,
                        ),
                      });
                    })
                  }
                />
                <div className="relative min-w-0 flex-1">
                  <Input
                    id="server-profile-backup-url"
                    ref={backupUrlInputRef}
                    disabled={disabled}
                    className="h-9 rounded-none rounded-r-md border-0 pr-10 shadow-none focus-visible:ring-0"
                    value={backupParts.rest}
                    onChange={(e) =>
                      updateDraft((prev) => {
                        const profile = getActiveServerProfile(prev);
                        const parts = parseServerUrlParts(
                          profile?.backup_url ?? "",
                        );
                        return patchActiveServerProfileBackup(prev, {
                          backup_url: composeServerUrl(
                            parts.scheme,
                            e.target.value,
                          ),
                        });
                      })
                    }
                    placeholder={backupRestPlaceholder}
                  />
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void pickServerPath("backup")}
                    title={t("common.actions.pickFolder")}
                    aria-label={t("common.actions.pickFolder")}
                    className="absolute top-1/2 right-1 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted transition-colors hover:bg-primary-soft hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  >
                    <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-muted">
                {t("settings.server.smb.backupUrlHint")}
              </p>
            </div>
          );
        })()}

        {(formProfile.backup_url ?? "").trim() ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="server-profile-backup-login">
                {t("settings.server.smb.backupLogin")}
              </Label>
              <Input
                id="server-profile-backup-login"
                disabled={disabled}
                value={formProfile.backup_login ?? ""}
                onChange={(e) =>
                  updateDraft((prev) =>
                    patchActiveServerProfileBackup(prev, {
                      backup_login: e.target.value,
                    }),
                  )
                }
                autoComplete="username"
                placeholder={t("settings.server.smb.backupCredsPlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="server-profile-backup-password">
                {t("settings.server.smb.backupPassword")}
              </Label>
              <PasswordInput
                id="server-profile-backup-password"
                disabled={disabled}
                value={formProfile.backup_password ?? ""}
                onChange={(e) =>
                  updateDraft((prev) =>
                    patchActiveServerProfileBackup(prev, {
                      backup_password: e.target.value,
                    }),
                  )
                }
                autoComplete="current-password"
              />
            </div>
          </div>
        ) : null}

        {footer ? <div className="pt-1">{footer}</div> : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {showList ? (
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

          <ul
            className="space-y-1.5"
            role="listbox"
            aria-label={t("settings.server.smb.profileListTitle")}
          >
            {profiles.map(renderProfileRow)}
          </ul>
        </div>
      ) : active && !singleWizardProfile ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {displayServerProfileLabel(active)}
            </p>
            <p className="truncate text-[11px] text-muted">
              {displayServerProfileSubtitle(active) ||
                t("settings.server.smb.profileNoUrl")}
            </p>
          </div>
          {!editorOpen ? (
            <div className="flex shrink-0 flex-wrap gap-1.5">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={disabled}
                onClick={() => onEditProfile(activeId)}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
                {t("settings.server.smb.editProfile")}
              </Button>
              {variant === "wizard" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={onAddProfile}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  {t("settings.server.smb.addProfile")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {!editorOpen && showList && active ? (
        <p className="text-[11px] text-muted">
          {t("settings.server.smb.profileActiveHint", {
            name: displayServerProfileLabel(active),
          })}
        </p>
      ) : null}

      {renderEditorForm()}
    </div>
  );
}

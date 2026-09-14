import type { Dispatch, SetStateAction } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Combobox } from "@/components/ui/combobox";
import { Switch } from "@/components/ui/switch";
import type { CrewMember } from "@/lib/tauri";
import {
  clearCrewRemovedName,
  crewAllNames,
  crewKeepComboboxValue,
  crewKeepPinnedOptions,
  crewNamesEqual,
  crewNamesForRole,
  findCrewMember,
  markCrewRemovedName,
  parseCrewKeepComboboxValue,
  upsertCrewMember,
} from "@/lib/tauri";
import { showAdvanced } from "@/lib/settingsUi";
import { cn } from "@/lib/utils";
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

type CrewEditor = {
  addName: string;
  setAddName: Dispatch<SetStateAction<string>>;
  renameDraft: string;
  setRenameDraft: Dispatch<SetStateAction<string>>;
  crewEditIndex: number | null;
  sortedCrew: { member: CrewMember; index: number }[];
  resetCrewForm: () => void;
  cancelEditCrew: () => void;
  startEditCrew: (index: number) => void;
  addCrewMember: () => void;
  saveRename: () => void;
  patchCrewRole: (
    index: number,
    role: "tandemmaster" | "videospringer",
    value: boolean,
  ) => void;
  deleteCrewMember: (index: number) => void;
};

type Props = SettingsTabBaseProps & {
  crewEditor: CrewEditor;
};

export function CrewTab({ draft, setDraft, commitNow, crewEditor, disclosure }: Props) {
  const { t } = useTranslation();
  const advanced = showAdvanced(disclosure);
  const tandemmasterOptions = crewNamesForRole(draft.crew_list, "tandemmaster");
  const videospringerOptions = crewNamesForRole(draft.crew_list, "videospringer");
  const allCrewNames = crewAllNames(draft.crew_list);
  const operatorMember = findCrewMember(draft.crew_list, draft.operator_name);
  const opName = draft.operator_name.trim();
  const {
    addName,
    setAddName,
    renameDraft,
    setRenameDraft,
    crewEditIndex,
    sortedCrew,
    cancelEditCrew,
    startEditCrew,
    addCrewMember,
    saveRename,
    patchCrewRole,
    deleteCrewMember,
  } = crewEditor;

  function setOperatorName(raw: string) {
    setDraft((prev) => (prev ? { ...prev, operator_name: raw } : prev));
  }

  function setOperatorRole(
    role: "tandemmaster" | "videospringer",
    value: boolean,
  ) {
    if (!opName) return;
    const current = findCrewMember(draft.crew_list, opName);
    const next = {
      tandemmaster:
        role === "tandemmaster" ? value : Boolean(current?.tandemmaster),
      videospringer:
        role === "videospringer" ? value : Boolean(current?.videospringer),
    };
    if (!next.tandemmaster && !next.videospringer) {
      if (current) {
        // Keep at least one role for existing roster entries.
        return;
      }
      commitNow((prev) =>
        prev
          ? {
              ...prev,
              crew_list: prev.crew_list.filter(
                (c) => !crewNamesEqual(c.name, opName),
              ),
              crew_removed_names: markCrewRemovedName(
                prev.crew_removed_names,
                opName,
              ),
            }
          : prev,
      );
      return;
    }
    commitNow((prev) =>
      prev
        ? {
            ...prev,
            crew_list: upsertCrewMember(prev.crew_list, opName, next),
            crew_removed_names: clearCrewRemovedName(
              prev.crew_removed_names,
              opName,
            ),
          }
        : prev,
    );
  }

  return (
    <div className="space-y-3">
      <SettingsSection title={t("settings.crew.who.title")}>
        <Combobox
          label={t("settings.crew.who.label")}
          value={draft.operator_name}
          onChange={setOperatorName}
          options={allCrewNames}
          placeholder={t("settings.crew.who.placeholder")}
          listZIndex={200}
        />
        {opName ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/70 px-3 py-2 text-sm">
              <span>{t("create.ready.chips.tandemmaster")}</span>
              <Switch
                checked={Boolean(operatorMember?.tandemmaster)}
                onCheckedChange={(v) => setOperatorRole("tandemmaster", v)}
                aria-label={t("create.ready.chips.tandemmaster")}
              />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/70 px-3 py-2 text-sm">
              <span>{t("create.ready.chips.videospringer")}</span>
              <Switch
                checked={Boolean(operatorMember?.videospringer)}
                onCheckedChange={(v) => setOperatorRole("videospringer", v)}
                aria-label={t("create.ready.chips.videospringer")}
              />
            </label>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t("settings.crew.session.title")}>
        <Combobox
          label={t("settings.crew.session.tandemmasterLabel")}
          value={crewKeepComboboxValue(
            draft.keep_tandemmaster_on_session_reset,
            draft.tandemmaster,
          )}
          onChange={(v) => {
            const { keep, name } = parseCrewKeepComboboxValue(v);
            commitNow((prev) =>
              prev
                ? {
                    ...prev,
                    keep_tandemmaster_on_session_reset: keep,
                    tandemmaster: name,
                  }
                : prev,
            );
          }}
          options={tandemmasterOptions}
          pinnedOptions={crewKeepPinnedOptions(
            draft.crew_list,
            "tandemmaster",
            draft.operator_name,
          )}
          placeholder={t("settings.crew.session.placeholder")}
          listZIndex={200}
        />
        <Combobox
          label={t("settings.crew.session.videospringerLabel")}
          value={crewKeepComboboxValue(
            draft.keep_videospringer_on_session_reset,
            draft.videospringer,
          )}
          onChange={(v) => {
            const { keep, name } = parseCrewKeepComboboxValue(v);
            commitNow((prev) =>
              prev
                ? {
                    ...prev,
                    keep_videospringer_on_session_reset: keep,
                    videospringer: name,
                  }
                : prev,
            );
          }}
          options={videospringerOptions}
          pinnedOptions={crewKeepPinnedOptions(
            draft.crew_list,
            "videospringer",
            draft.operator_name,
          )}
          placeholder={t("settings.crew.session.placeholder")}
          listZIndex={200}
        />
      </SettingsSection>

      {advanced ? (
      <SettingsSection
        title={t("settings.crew.list.title")}
        description={t("settings.crew.list.description")}
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1.5">
            <Label>{t("create.ready.chips.name")}</Label>
            <Input
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder={t("settings.crew.list.namePlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCrewMember();
                }
              }}
            />
          </div>
          <div className="flex items-end gap-2">
            <Button type="button" onClick={addCrewMember}>
              <Plus className="h-4 w-4" />
              {t("common.actions.add")}
            </Button>
          </div>
        </div>

        <div className="max-h-72 overflow-auto rounded-md border border-border">
          {sortedCrew.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">
              {t("settings.crew.list.empty")}
            </p>
          ) : (
            <>
              <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 border-b border-border bg-card-elevated/95 px-3 py-1.5 text-[10px] font-semibold tracking-wide text-muted uppercase">
                <span>{t("create.ready.chips.name")}</span>
                <span className="w-28 text-center">
                  {t("create.ready.chips.tandemmaster")}
                </span>
                <span className="w-28 text-center">
                  {t("create.ready.chips.videospringer")}
                </span>
                <span className="w-20 text-right">
                  {t("settings.crew.list.action")}
                </span>
              </div>
              <ul className="divide-y divide-border">
                {sortedCrew.map(({ member, index }) => {
                  const editing = crewEditIndex === index;
                  return (
                    <li
                      key={`${member.name}-${index}`}
                      className={cn(
                        "grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 px-3 py-2",
                        editing && "bg-primary-soft/40",
                      )}
                    >
                      {editing ? (
                        <Input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              saveRename();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              cancelEditCrew();
                            }
                          }}
                          aria-label={t("common.actions.rename")}
                          className="h-8"
                        />
                      ) : (
                        <p
                          className="truncate text-sm font-medium"
                          title={member.name}
                          onDoubleClick={() => startEditCrew(index)}
                        >
                          {member.name}
                          {crewNamesEqual(member.name, draft.operator_name) ? (
                            <span className="ml-2 text-[10px] font-normal text-muted">
                              {t("settings.crew.list.me")}
                            </span>
                          ) : null}
                        </p>
                      )}
                      <div className="flex w-28 justify-center">
                        <Switch
                          checked={member.tandemmaster}
                          onCheckedChange={(v) =>
                            patchCrewRole(index, "tandemmaster", v)
                          }
                          aria-label={t("settings.crew.list.ariaRole", {
                            name: member.name,
                            role: t("create.ready.chips.tandemmaster"),
                          })}
                        />
                      </div>
                      <div className="flex w-28 justify-center">
                        <Switch
                          checked={member.videospringer}
                          onCheckedChange={(v) =>
                            patchCrewRole(index, "videospringer", v)
                          }
                          aria-label={t("settings.crew.list.ariaRole", {
                            name: member.name,
                            role: t("create.ready.chips.videospringer"),
                          })}
                        />
                      </div>
                      <div className="flex w-20 justify-end gap-0.5">
                        {editing ? (
                          <>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              title={t("common.actions.save")}
                              onClick={saveRename}
                            >
                              <Check className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              title={t("common.actions.cancel")}
                              onClick={cancelEditCrew}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              title={t("common.actions.rename")}
                              onClick={() => startEditCrew(index)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              title={t("common.actions.delete")}
                              onClick={() => deleteCrewMember(index)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </SettingsSection>
      ) : null}
    </div>
  );
}

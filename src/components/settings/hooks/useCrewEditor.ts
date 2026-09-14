import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig } from "@/lib/tauri";
import {
  clearCrewRemovedName,
  crewNamesEqual,
  markCrewRemovedName,
  syncOperatorName,
} from "@/lib/tauri";
import { useUiStore } from "@/store/uiStore";
import type { SettingsTabBaseProps } from "../types";

type Props = {
  draft: AppConfig | null;
  patchNow: SettingsTabBaseProps["patchNow"];
  commitNow: SettingsTabBaseProps["commitNow"];
};

export function useCrewEditor({
  draft,
  patchNow,
  commitNow,
}: Props) {
  const { t } = useTranslation();
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const [addName, setAddName] = useState("");
  const [crewEditIndex, setCrewEditIndex] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const crewList = draft?.crew_list ?? [];

  const sortedCrew = useMemo(
    () =>
      crewList
        .map((member, index) => ({ member, index }))
        .sort((a, b) => a.member.name.localeCompare(b.member.name, "de")),
    [crewList],
  );

  function resetCrewForm() {
    setAddName("");
    setCrewEditIndex(null);
    setRenameDraft("");
  }

  function cancelEditCrew() {
    setCrewEditIndex(null);
    setRenameDraft("");
  }

  function startEditCrew(index: number) {
    const member = crewList[index];
    if (!member) return;
    setCrewEditIndex(index);
    setRenameDraft(member.name);
  }

  function commitNameChange(index: number | null, rawName: string) {
    if (!draft) return false;
    const name = rawName.trim();
    if (!name) {
      showError(t("settings.crew.errors.nameRequired"), t("settings.tabs.crew"));
      return false;
    }
    const duplicate = crewList.some(
      (c, i) =>
        c.name.trim().toLowerCase() === name.toLowerCase() && i !== index,
    );
    if (duplicate) {
      showError(t("settings.crew.errors.duplicate"), t("settings.tabs.crew"));
      return false;
    }
    const list = [...crewList];
    let prevName = "";
    if (index == null) {
      list.push({
        name,
        tandemmaster: true,
        videospringer: false,
      });
    } else {
      const prev = list[index];
      if (!prev) return false;
      if (crewNamesEqual(prev.name, name)) {
        cancelEditCrew();
        return true;
      }
      prevName = prev.name;
      list[index] = {
        name,
        tandemmaster: prev.tandemmaster,
        videospringer: prev.videospringer,
      };
    }
    list.sort((a, b) => a.name.localeCompare(b.name, "de"));
    const nextOperator = syncOperatorName(
      draft.operator_name,
      prevName,
      name,
    );
    commitNow((prev) => {
      if (!prev) return prev;
      let removed = clearCrewRemovedName(prev.crew_removed_names, name);
      if (prevName && !crewNamesEqual(prevName, name)) {
        removed = markCrewRemovedName(removed, prevName);
      }
      return {
        ...prev,
        crew_list: list,
        crew_removed_names: removed,
        operator_name: nextOperator,
      };
    });
    return true;
  }

  function addCrewMember() {
    if (!commitNameChange(null, addName)) return;
    resetCrewForm();
  }

  function saveRename() {
    if (crewEditIndex == null) return;
    if (!commitNameChange(crewEditIndex, renameDraft)) return;
    cancelEditCrew();
  }

  function patchCrewRole(
    index: number,
    role: "tandemmaster" | "videospringer",
    value: boolean,
  ) {
    if (!draft) return;
    const list = crewList.map((m, i) =>
      i === index ? { ...m, [role]: value } : m,
    );
    const updated = list[index];
    if (updated && !updated.tandemmaster && !updated.videospringer) {
      showError(t("settings.crew.errors.roleRequired"), t("settings.tabs.crew"));
      return;
    }
    patchNow("crew_list", list);
  }

  function deleteCrewMember(index: number) {
    if (!draft) return;
    const member = crewList[index];
    if (!member) return;
    if (!window.confirm(t("settings.crew.errors.removeConfirm", { name: member.name }))) return;
    const nextOperator = syncOperatorName(
      draft.operator_name,
      member.name,
      null,
    );
    const clearedOperator =
      nextOperator !== draft.operator_name && !nextOperator.trim();
    commitNow((prev) =>
      prev
        ? {
            ...prev,
            crew_list: crewList.filter((_, i) => i !== index),
            crew_removed_names: markCrewRemovedName(
              prev.crew_removed_names,
              member.name,
            ),
            operator_name: nextOperator,
          }
        : prev,
    );
    if (clearedOperator) {
      showSuccess(
        t("settings.crew.errors.removedFavorite", { name: member.name }),
        t("settings.tabs.crew"),
      );
    }
    if (crewEditIndex === index) cancelEditCrew();
    else if (crewEditIndex != null && crewEditIndex > index) {
      setCrewEditIndex(crewEditIndex - 1);
    }
  }

  return {
    addName,
    setAddName,
    renameDraft,
    setRenameDraft,
    crewEditIndex,
    sortedCrew,
    resetCrewForm,
    cancelEditCrew,
    startEditCrew,
    addCrewMember,
    saveRename,
    patchCrewRole,
    deleteCrewMember,
  };
}

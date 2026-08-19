import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig, CrewMember } from "@/lib/tauri";
import { syncOperatorName } from "@/lib/tauri";
import { useUiStore } from "@/store/uiStore";
import type { SettingsTabBaseProps } from "../types";

type Props = {
  draft: AppConfig | null;
  patch: SettingsTabBaseProps["patch"];
  setDraft: SettingsTabBaseProps["setDraft"];
};

export function useCrewEditor({ draft, patch, setDraft }: Props) {
  const { t } = useTranslation();
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const [crewDraft, setCrewDraft] = useState<CrewMember>({
    name: "",
    tandemmaster: true,
    videospringer: false,
  });
  const [crewEditIndex, setCrewEditIndex] = useState<number | null>(null);
  const crewList = draft?.crew_list ?? [];

  const sortedCrew = useMemo(
    () =>
      crewList
        .map((member, index) => ({ member, index }))
        .sort((a, b) => a.member.name.localeCompare(b.member.name, "de")),
    [crewList],
  );

  function resetCrewForm() {
    setCrewDraft({ name: "", tandemmaster: true, videospringer: false });
    setCrewEditIndex(null);
  }

  function startEditCrew(index: number) {
    const member = crewList[index];
    if (!member) return;
    setCrewDraft({ ...member });
    setCrewEditIndex(index);
  }

  function saveCrewMember() {
    if (!draft) return;
    const name = crewDraft.name.trim();
    if (!name) {
      showError(t("settings.crew.errors.nameRequired"), t("settings.tabs.crew"));
      return;
    }
    const duplicate = crewList.some(
      (c, i) =>
        c.name.trim().toLowerCase() === name.toLowerCase() &&
        i !== crewEditIndex,
    );
    if (duplicate) {
      showError(t("settings.crew.errors.duplicate"), t("settings.tabs.crew"));
      return;
    }
    const list = [...crewList];
    let prevName = "";
    if (crewEditIndex == null) {
      list.push({
        name,
        tandemmaster: true,
        videospringer: false,
      });
    } else {
      const prev = list[crewEditIndex];
      prevName = prev?.name ?? "";
      list[crewEditIndex] = {
        name,
        tandemmaster: prev?.tandemmaster ?? true,
        videospringer: prev?.videospringer ?? false,
      };
    }
    list.sort((a, b) => a.name.localeCompare(b.name, "de"));
    const nextOperator = syncOperatorName(
      draft.operator_name,
      prevName,
      name,
    );
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            crew_list: list,
            operator_name: nextOperator,
          }
        : prev,
    );
    resetCrewForm();
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
    patch("crew_list", list);
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
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            crew_list: crewList.filter((_, i) => i !== index),
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
    if (crewEditIndex === index) resetCrewForm();
    else if (crewEditIndex != null && crewEditIndex > index) {
      setCrewEditIndex(crewEditIndex - 1);
    }
  }

  return {
    crewDraft,
    setCrewDraft,
    crewEditIndex,
    sortedCrew,
    resetCrewForm,
    startEditCrew,
    saveCrewMember,
    patchCrewRole,
    deleteCrewMember,
  };
}

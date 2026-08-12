import { useMemo, useState } from "react";
import type { AppConfig, CrewMember } from "@/lib/tauri";
import { useUiStore } from "@/store/uiStore";
import type { SettingsTabBaseProps } from "../types";

type Props = {
  draft: AppConfig | null;
  patch: SettingsTabBaseProps["patch"];
};

export function useCrewEditor({ draft, patch }: Props) {
  const showError = useUiStore((s) => s.showError);
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
      showError("Bitte einen Namen eingeben.", "Crew");
      return;
    }
    const duplicate = crewList.some(
      (c, i) =>
        c.name.trim().toLowerCase() === name.toLowerCase() &&
        i !== crewEditIndex,
    );
    if (duplicate) {
      showError("Dieser Name ist bereits in der Liste.", "Crew");
      return;
    }
    const list = [...crewList];
    if (crewEditIndex == null) {
      list.push({
        name,
        tandemmaster: true,
        videospringer: false,
      });
    } else {
      const prev = list[crewEditIndex];
      list[crewEditIndex] = {
        name,
        tandemmaster: prev?.tandemmaster ?? true,
        videospringer: prev?.videospringer ?? false,
      };
    }
    list.sort((a, b) => a.name.localeCompare(b.name, "de"));
    patch("crew_list", list);
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
      showError("Mindestens eine Rolle muss aktiv sein.", "Crew");
      return;
    }
    patch("crew_list", list);
  }

  function deleteCrewMember(index: number) {
    if (!draft) return;
    const member = crewList[index];
    if (!member) return;
    if (!window.confirm(`„${member.name}“ aus der Crew-Liste entfernen?`)) return;
    patch(
      "crew_list",
      crewList.filter((_, i) => i !== index),
    );
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

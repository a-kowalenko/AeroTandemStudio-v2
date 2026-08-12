import type { Dispatch, SetStateAction } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import type { CrewMember } from "@/lib/tauri";
import {
  crewKeepComboboxValue,
  CREW_KEEP_PINNED_OPTIONS,
  crewNamesForRole,
  parseCrewKeepComboboxValue,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { SettingsSection } from "../SettingsSection";
import type { SettingsTabBaseProps } from "../types";

type CrewEditor = {
  crewDraft: CrewMember;
  setCrewDraft: Dispatch<SetStateAction<CrewMember>>;
  crewEditIndex: number | null;
  sortedCrew: { member: CrewMember; index: number }[];
  resetCrewForm: () => void;
  startEditCrew: (index: number) => void;
  saveCrewMember: () => void;
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

export function CrewTab({ draft, setDraft, crewEditor }: Props) {
  const tandemmasterOptions = crewNamesForRole(draft.crew_list, "tandemmaster");
  const videospringerOptions = crewNamesForRole(draft.crew_list, "videospringer");
  const {
    crewDraft,
    setCrewDraft,
    crewEditIndex,
    sortedCrew,
    resetCrewForm,
    startEditCrew,
    saveCrewMember,
    patchCrewRole,
    deleteCrewMember,
  } = crewEditor;

  return (
    <div className="space-y-4">
      <SettingsSection
        title="Session zurücksetzen"
        description="Nach dem Erstellen eines Vorgangs: Modus oder festen Namen für Tandemmaster und Videospringer."
      >
        <Combobox
          label="Tandemmaster beim Zurücksetzen"
          value={crewKeepComboboxValue(
            draft.keep_tandemmaster_on_session_reset,
            draft.tandemmaster,
          )}
          onChange={(v) => {
            const { keep, name } = parseCrewKeepComboboxValue(v);
            setDraft((prev) =>
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
          pinnedOptions={CREW_KEEP_PINNED_OPTIONS}
          placeholder="Modus oder Name wählen…"
          hint="Oben Modus wählen, oder einen festen Namen aus der Crew."
          listZIndex={200}
        />
        <Combobox
          label="Videospringer beim Zurücksetzen"
          value={crewKeepComboboxValue(
            draft.keep_videospringer_on_session_reset,
            draft.videospringer,
          )}
          onChange={(v) => {
            const { keep, name } = parseCrewKeepComboboxValue(v);
            setDraft((prev) =>
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
          pinnedOptions={CREW_KEEP_PINNED_OPTIONS}
          placeholder="Modus oder Name wählen…"
          hint="Oben Modus wählen, oder einen festen Namen aus der Crew."
          listZIndex={200}
        />
      </SettingsSection>

      <SettingsSection
        title="Crew-Liste"
        description="Namen erscheinen je nach Rolle in den Comboboxen. Freitext im Formular bleibt weiterhin möglich."
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={crewDraft.name}
              onChange={(e) =>
                setCrewDraft((prev) => ({ ...prev, name: e.target.value }))
              }
              placeholder="z. B. Andy"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveCrewMember();
                }
              }}
            />
          </div>
          <div className="flex items-end gap-2">
            <Button type="button" onClick={saveCrewMember}>
              {crewEditIndex == null ? (
                <>
                  <Plus className="h-4 w-4" />
                  Hinzufügen
                </>
              ) : (
                "Umbenennen"
              )}
            </Button>
            {crewEditIndex != null ? (
              <Button type="button" variant="secondary" onClick={resetCrewForm}>
                Abbrechen
              </Button>
            ) : null}
          </div>
        </div>

        <div className="max-h-72 overflow-auto rounded-md border border-border">
          {sortedCrew.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">
              Noch keine Einträge — oben hinzufügen.
            </p>
          ) : (
            <>
              <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 border-b border-border bg-card-elevated/95 px-3 py-1.5 text-[10px] font-semibold tracking-wide text-muted uppercase">
                <span>Name</span>
                <span className="w-28 text-center">Tandemmaster</span>
                <span className="w-28 text-center">Videospringer</span>
                <span className="w-20 text-right">Aktion</span>
              </div>
              <ul className="divide-y divide-border">
                {sortedCrew.map(({ member, index }) => (
                  <li
                    key={`${member.name}-${index}`}
                    className={cn(
                      "grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 px-3 py-2",
                      crewEditIndex === index && "bg-primary-soft/40",
                    )}
                  >
                    <p className="truncate text-sm font-medium" title={member.name}>
                      {member.name}
                    </p>
                    <div className="flex w-28 justify-center">
                      <Checkbox
                        checked={member.tandemmaster}
                        onCheckedChange={(v) =>
                          patchCrewRole(index, "tandemmaster", v === true)
                        }
                        aria-label={`${member.name}: Tandemmaster`}
                      />
                    </div>
                    <div className="flex w-28 justify-center">
                      <Checkbox
                        checked={member.videospringer}
                        onCheckedChange={(v) =>
                          patchCrewRole(index, "videospringer", v === true)
                        }
                        aria-label={`${member.name}: Videospringer`}
                      />
                    </div>
                    <div className="flex w-20 justify-end gap-0.5">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        title="Umbenennen"
                        onClick={() => startEditCrew(index)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        title="Löschen"
                        onClick={() => deleteCrewMember(index)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}

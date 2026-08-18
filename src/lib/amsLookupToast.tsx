import toast from "react-hot-toast";
import { AmsLookupToastCard } from "../components/AmsLookupToastCard";
import { formatAmsLookupFoundToast } from "./amsLookup";
import type { Kunde } from "./tauri";

const DURATION_MS = 4500;

/** Non-blocking success toast after AMS ID-lookup is applied. */
export function showAmsLookupFoundToast(kunde: Kunde): void {
  const { title, name, media } = formatAmsLookupFoundToast(kunde);
  toast.custom(
    (t) => (
      <AmsLookupToastCard
        visible={t.visible}
        title={title}
        name={name}
        media={media || undefined}
        durationMs={DURATION_MS}
        onDismiss={() => toast.dismiss(t.id)}
      />
    ),
    { duration: DURATION_MS, id: "ams-lookup-found" },
  );
}

import { X } from "lucide-react";
import { BUTTON_GHOST, SettingsGroup, SettingsRow } from "./layout";

/**
 * 「一直允许」: what an approval card's 「一直允许」 put on the global list, and
 * the one place to take an entry back off it (the card promises as much). There
 * is nothing to show until there is an entry, so an empty list is no section.
 */
export function AllowlistSection({ entries, saving, onRemove }: {
  entries: readonly string[];
  saving: boolean;
  onRemove: (entry: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <SettingsGroup title="一直允许">
      {entries.map((entry) => (
        <SettingsRow key={entry} title={<span className="break-all font-mono">{entry}</span>}>
          <button type="button" aria-label={`移除 ${entry}`} title="移除" disabled={saving} onClick={() => onRemove(entry)} className={BUTTON_GHOST}>
            <X className="size-md" />
          </button>
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

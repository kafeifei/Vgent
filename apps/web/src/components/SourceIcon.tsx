import { useEffect, useState } from "react";
import type { ModelEntry } from "@/lib/types";

type Source = NonNullable<ModelEntry["source"]>;

const logoUrl = (id: string): string => `https://models.dev/logos/${encodeURIComponent(id)}.svg`;

/** Which logos have loaded, so a menu that reopens does not flash initials first. */
const loaded = new Set<string>();

/**
 * Whose model a row is: the provider's logo from the catalog (models.dev serves
 * one per provider), painted as a mask so it takes the text colour in both
 * themes. A source the catalog does not know — a company gateway — or a logo
 * that did not arrive (offline) is its initial instead.
 */
export function SourceIcon({ source }: { source: Source }) {
  const logo = source.logo;
  const [ready, setReady] = useState(logo != null && loaded.has(logo));

  useEffect(() => {
    if (logo == null || loaded.has(logo)) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      loaded.add(logo);
      if (!cancelled) setReady(true);
    };
    image.src = logoUrl(logo);
    return () => {
      cancelled = true;
    };
  }, [logo]);

  if (logo != null && ready) {
    const mask = `url("${logoUrl(logo)}") center / contain no-repeat`;
    return <span aria-hidden title={source.name} className="size-md flex-none bg-current" style={{ mask, WebkitMask: mask }} />;
  }
  const letter = [...source.name.trim()][0]?.toUpperCase() ?? "?";
  return (
    <span aria-hidden title={source.name} className="grid size-md flex-none place-items-center rounded-sm bg-bg-inset font-medium text-2xs text-fg-muted">
      {letter}
    </span>
  );
}

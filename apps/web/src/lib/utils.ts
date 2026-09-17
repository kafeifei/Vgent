import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** The `cn` helper every fetched shadcn / AI Elements file imports. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

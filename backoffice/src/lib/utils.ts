import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind-aware class joiner: later classes win over the ones they conflict with. */
export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

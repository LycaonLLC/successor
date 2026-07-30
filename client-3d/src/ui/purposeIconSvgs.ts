import {
  CRAFT_PURPOSE_ICON_SVGS,
  type CraftPurposeIconKey,
} from "./craftPurposeIconSvgs.gen";
import {
  PURPOSE_ICON_SVGS as BASE_PURPOSE_ICON_SVGS,
  type PurposeIconKey as BasePurposeIconKey,
} from "./purposeIconSvgs.gen";

/**
 * Hand-authored craft-slot silhouettes that are not part of the generated
 * purpose sheet. Same contract as the generated set: complete inline <svg>,
 * fill="currentColor", aria-hidden so chrome ink/accent carries the color.
 */
export type HandPurposeIconKey = "purpose.body" | "purpose.charge";

const HAND_PURPOSE_ICON_SVGS: Record<HandPurposeIconKey, string> = {
  // Forged slug body — solid projectile silhouette for ammo body slots.
  "purpose.body":
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    + '<path d="M12 2.4c1.15 0 2.1.7 2.45 1.7l2.95 8.35c.4 1.15.6 2.35.6 3.55 0 2.95-2.5 4.85-6 4.85s-6-1.9-6-4.85c0-1.2.2-2.4.6-3.55L9.55 4.1C9.9 3.1 10.85 2.4 12 2.4zm0 2.15c-.35 0-.65.2-.75.5L8.45 13.1c-.3.9-.45 1.85-.45 2.75 0 1.85 1.55 3.1 4 3.1s4-1.25 4-3.1c0-.9-.15-1.85-.45-2.75L12.75 5.05c-.1-.3-.4-.5-.75-.5z"/>'
    + '<path d="M10.2 13.2h3.6l-.55 1.7h-2.5z"/>'
    + '</svg>',
  // Pressed charge wafer — solid disc for propellant/charge slots.
  "purpose.charge":
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
    + '<path d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 2.25a6.75 6.75 0 1 0 0 13.5 6.75 6.75 0 0 0 0-13.5z"/>'
    + '<path d="M12 7.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 1.75a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5z"/>'
    + '<path d="M11.15 11.15h1.7v1.7h-1.7z"/>'
    + '</svg>',
};

/** The complete generated purpose-icon vocabulary consumed by live UI maps. */
export type PurposeIconKey = BasePurposeIconKey | CraftPurposeIconKey | HandPurposeIconKey;

export const PURPOSE_ICON_SVGS: Record<PurposeIconKey, string> = {
  ...BASE_PURPOSE_ICON_SVGS,
  ...CRAFT_PURPOSE_ICON_SVGS,
  ...HAND_PURPOSE_ICON_SVGS,
};

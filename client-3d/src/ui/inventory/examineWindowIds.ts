/** Eager examine item binding (opener seam). */
let examineKey: string | null = null;

/** Set the item key the examine window previews (then `open("examine")`). */
export function setExamineItem(key: string): void {
  examineKey = key;
}

/** Internal read for the examine content mount. */
export function examineItemKeyRef(): string | null {
  return examineKey;
}

/** Eager prop-examine id + binding. */
export const PROP_EXAMINE_WINDOW_ID = "propExamine";

let examinedPropId: string | null = null;

export function setExaminedProp(propId: string): void {
  examinedPropId = propId;
}

/** Internal read for the prop-examine content mount. */
export function examinedPropIdRef(): string | null {
  return examinedPropId;
}

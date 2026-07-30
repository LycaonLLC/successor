/** Eager macros window id + notice sink type (runtime stays in macros/runtime). */
export interface MacroNoticeSink {
  /** One formatted notice per call ({text, bad}), null when drained. */
  take(): { text: string; bad: boolean } | null;
}
export const MACROS_WINDOW_ID = "macros";

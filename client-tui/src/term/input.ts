/**
 * Key decoder — raw stdin bytes → semantic key events.
 *
 * Covers the surface a MUD needs: printables (incl. UTF-8), Enter/Tab/
 * Backspace/Delete, arrows + Home/End/PgUp/PgDn (CSI and SS3 forms), ctrl
 * chords, alt-prefixed keys, and bracketed paste (pasted text arrives as ONE
 * event so macro bodies survive intact). Partial escape sequences buffer
 * across chunks; a lone ESC resolves on the next chunk boundary.
 */

export interface KeyEvent {
  kind: "char" | "special" | "paste";
  /** For kind=char: the printable string. For paste: the pasted text. */
  value: string;
  /** For kind=special: name below. */
  name?: SpecialKey;
  ctrl?: boolean;
  alt?: boolean;
}

export type SpecialKey =
  | "enter" | "tab" | "backspace" | "delete" | "escape"
  | "up" | "down" | "left" | "right"
  | "home" | "end" | "pageup" | "pagedown";

const CSI_FINAL: Record<string, SpecialKey> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

const CSI_TILDE: Record<string, SpecialKey> = {
  "1": "home",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
};

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

export class KeyDecoder {
  private buffer = "";
  private pasting = false;
  private pasteBuffer = "";

  /** Decode a stdin chunk; returns the completed events. */
  push(chunk: string): KeyEvent[] {
    this.buffer += chunk;
    const events: KeyEvent[] = [];
    while (this.buffer.length > 0) {
      if (this.pasting) {
        const end = this.buffer.indexOf(PASTE_END);
        if (end === -1) {
          this.pasteBuffer += this.buffer;
          this.buffer = "";
          break;
        }
        this.pasteBuffer += this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + PASTE_END.length);
        events.push({ kind: "paste", value: this.pasteBuffer });
        this.pasteBuffer = "";
        this.pasting = false;
        continue;
      }
      const consumed = this.decodeOne(events);
      if (consumed === 0) break; // partial sequence — wait for more bytes
      this.buffer = this.buffer.slice(consumed);
    }
    return events;
  }

  /** Flush a dangling lone ESC (chunk boundary) into an escape event. */
  flush(): KeyEvent[] {
    if (this.buffer === "\u001b") {
      this.buffer = "";
      return [{ kind: "special", value: "", name: "escape" }];
    }
    return [];
  }

  private decodeOne(events: KeyEvent[]): number {
    const b = this.buffer;
    const c0 = b.charCodeAt(0);

    if (b.startsWith(PASTE_START)) {
      this.pasting = true;
      return PASTE_START.length;
    }

    if (c0 === 0x1b) {
      if (b.length === 1) return 0; // maybe more coming
      const c1 = b[1]!;
      if (c1 === "[" || c1 === "O") {
        const seq = this.decodeCsi(b, c1 === "O");
        if (seq === null) return 0;
        if (seq.key) events.push({ kind: "special", value: "", name: seq.key });
        return seq.length;
      }
      // alt-prefixed printable or alt+control
      const inner = new KeyDecoder().push(b.slice(1, 2));
      const first = inner[0];
      if (first) events.push({ ...first, alt: true });
      else events.push({ kind: "special", value: "", name: "escape" });
      return 2;
    }

    if (c0 === 0x0d || c0 === 0x0a) {
      events.push({ kind: "special", value: "", name: "enter" });
      return 1;
    }
    if (c0 === 0x09) {
      events.push({ kind: "special", value: "", name: "tab" });
      return 1;
    }
    if (c0 === 0x7f || c0 === 0x08) {
      events.push({ kind: "special", value: "", name: "backspace" });
      return 1;
    }
    if (c0 < 0x20) {
      // ctrl chord: ^A..^Z map to letters
      const letter = String.fromCharCode(c0 + 0x60);
      events.push({ kind: "char", value: letter, ctrl: true });
      return 1;
    }
    // printable — take one full code point
    const cp = b.codePointAt(0)!;
    const ch = String.fromCodePoint(cp);
    events.push({ kind: "char", value: ch });
    return ch.length;
  }

  private decodeCsi(b: string, ss3: boolean): { key: SpecialKey | null; length: number } | null {
    // ESC [ params final  |  ESC O final
    let i = 2;
    if (ss3) {
      if (b.length < 3) return null;
      return { key: CSI_FINAL[b[2]!] ?? null, length: 3 };
    }
    let params = "";
    while (i < b.length) {
      const ch = b[i]!;
      if (ch >= "0" && ch <= "9" || ch === ";") {
        params += ch;
        i += 1;
        continue;
      }
      if (ch === "~") {
        const base = params.split(";")[0] ?? "";
        return { key: CSI_TILDE[base] ?? null, length: i + 1 };
      }
      return { key: CSI_FINAL[ch] ?? null, length: i + 1 };
    }
    return null; // incomplete
  }
}

// "Play old intro" — the owner-ratified character-creator theme.
// Rules from the brief: silent and unfetched until the click, no loop,
// fade in to 35%, pause on hidden tab, never remember the on-state.

export interface AudioLike {
  volume: number;
  loop: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
}

export interface OldIntroOptions {
  createAudio?: (src: string) => AudioLike;
  fadeMs?: number;
  targetVolume?: number;
  doc?: Document;
}

export const OLD_INTRO_SRC = "/audio/old-intro-charcreate.mp3";

function defaultCreateAudio(src: string): AudioLike {
  const audio = new Audio(src);
  audio.preload = "auto";
  return audio;
}

export function initOldIntro(button: HTMLButtonElement, options: OldIntroOptions = {}): void {
  const {
    createAudio = defaultCreateAudio,
    fadeMs = 800,
    targetVolume = 0.35,
    doc = document,
  } = options;

  let audio: AudioLike | null = null;
  let playing = false;
  let fadeTimer: number | null = null;
  const labelOff = button.dataset.labelOff ?? "Play old intro";
  const labelOn = button.dataset.labelOn ?? "Music on · stop";

  const stopFade = (): void => {
    if (fadeTimer !== null) {
      clearInterval(fadeTimer);
      fadeTimer = null;
    }
  };

  const setOff = (): void => {
    playing = false;
    stopFade();
    button.textContent = labelOff;
    button.setAttribute("aria-pressed", "false");
  };

  const stop = (): void => {
    audio?.pause();
    setOff();
  };

  const fadeIn = (): void => {
    if (!audio) return;
    if (fadeMs <= 0) {
      audio.volume = targetVolume;
      return;
    }
    const startedAt = Date.now();
    stopFade();
    fadeTimer = window.setInterval(() => {
      if (!audio || !playing) {
        stopFade();
        return;
      }
      const t = Math.min(1, (Date.now() - startedAt) / fadeMs);
      audio.volume = t * targetVolume;
      if (t >= 1) stopFade();
    }, 50);
  };

  button.addEventListener("click", () => {
    if (playing) {
      stop();
      return;
    }
    if (!audio) {
      // First click is the first byte fetched.
      audio = createAudio(OLD_INTRO_SRC);
      audio.loop = false;
      audio.addEventListener("ended", setOff);
    }
    audio.volume = 0;
    playing = true;
    button.textContent = labelOn;
    button.setAttribute("aria-pressed", "true");
    audio
      .play()
      .then(fadeIn)
      .catch(() => setOff());
  });

  // A hidden tab silences the room and forgets the on-state on purpose.
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "hidden" && playing) stop();
  });
}

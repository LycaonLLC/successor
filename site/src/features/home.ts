// Home progressive enhancement: cinematic reel source pick, reduced-motion
// static fallback, optional mute control only when the reel has audio, and
// scroll-earned reveals that never gate content on JS having run.
//
// mediaMode contract:
//   "video"  — reel is playing; video overlays the poster
//   "static" — poster only (reduced motion, autoplay block, or media error)

const REVEAL_SAFETY_MS = 2500;
const TERMINAL_INTRO_MS = 10_500;

function initReveals(doc: Document, reduced: boolean): void {
  const items = [...doc.querySelectorAll<HTMLElement>("[data-reveal]")];
  if (items.length === 0) return;

  const releaseAll = (): void => {
    for (const el of items) el.classList.add("is-in");
  };

  if (reduced || typeof IntersectionObserver !== "function") {
    releaseAll();
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
  );

  for (const el of items) io.observe(el);
  setTimeout(releaseAll, REVEAL_SAFETY_MS);
}

function wireSoundControl(hero: HTMLElement, video: HTMLVideoElement, doc: Document): void {
  const button = hero.querySelector<HTMLButtonElement>("[data-cinema-sound]");
  if (!button) return;

  const labelMute = button.dataset.labelMute ?? "Mute";
  const labelUnmute = button.dataset.labelUnmute ?? "Sound on";

  const sync = (): void => {
    const muted = video.muted || video.volume === 0;
    button.setAttribute("aria-pressed", muted ? "false" : "true");
    button.textContent = muted ? labelUnmute : labelMute;
  };

  const revealIfAudio = (): void => {
    // Only show a control when the media actually carries an audio track.
    const anyVideo = video as HTMLVideoElement & {
      audioTracks?: { length: number };
      mozHasAudio?: boolean;
      webkitAudioDecodedByteCount?: number;
    };
    const tracks = anyVideo.audioTracks;
    const hasTrackList = tracks !== undefined && tracks.length > 0;
    const gecko = anyVideo.mozHasAudio === true;
    const webkit =
      typeof anyVideo.webkitAudioDecodedByteCount === "number" &&
      anyVideo.webkitAudioDecodedByteCount > 0;
    // If the browser cannot report tracks, keep the control hidden — cinematic
    // reels are authored silent; explicit mute only when audio is proven.
    const hasAudio = hasTrackList || gecko || webkit;
    button.hidden = !hasAudio;
    if (hasAudio) sync();
  };

  button.addEventListener("click", () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 1;
    sync();
  });

  video.addEventListener("loadedmetadata", revealIfAudio);
  video.addEventListener("loadeddata", revealIfAudio);
  video.addEventListener("playing", revealIfAudio);
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "hidden") {
      video.pause();
    } else if (hero.dataset.mediaMode === "video") {
      void video.play().catch(() => {
        /* autoplay may still be blocked; poster remains underneath */
      });
    }
  });
}

function initCinemaHero(doc: Document, reduced: boolean): void {
  const hero = doc.querySelector<HTMLElement>("[data-cinema-hero]");
  if (!hero) return;

  const video = hero.querySelector<HTMLVideoElement>("[data-cinema-video]");
  if (!video) {
    hero.dataset.mediaMode = "static";
    return;
  }

  if (reduced) {
    hero.dataset.mediaMode = "static";
    video.removeAttribute("autoplay");
    video.pause();
    video.removeAttribute("src");
    while (video.firstChild) video.removeChild(video.firstChild);
    video.load();
    return;
  }

  const desktopWebm = video.dataset.srcDesktopWebm;
  const desktopMp4 = video.dataset.srcDesktopMp4;
  const mobileWebm = video.dataset.srcMobileWebm;
  const mobileMp4 = video.dataset.srcMobileMp4;
  const posterDesktop = video.dataset.posterDesktop;
  const posterMobile = video.dataset.posterMobile;
  let desktopFallback = false;

  const pick = (): void => {
    const mobile =
      !desktopFallback &&
      typeof matchMedia === "function" &&
      matchMedia("(max-width: 47.99rem)").matches;
    const poster = mobile ? (posterMobile ?? video.poster) : (posterDesktop ?? video.poster);
    if (poster) {
      video.poster = poster;
    }
    const webm = mobile ? mobileWebm : desktopWebm;
    const mp4 = mobile ? mobileMp4 : desktopMp4;

    video.replaceChildren();
    // MP4 first gives the widest reliable CDN/mobile playback path; WebM remains
    // the efficient fallback for browsers that prefer it.
    if (mp4) {
      const s = doc.createElement("source");
      s.src = mp4;
      s.type = "video/mp4";
      video.append(s);
    }
    if (webm) {
      const s = doc.createElement("source");
      s.src = webm;
      s.type = "video/webm";
      video.append(s);
    }
    video.load();
  };

  pick();
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.loop = true;
  video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
  video.setAttribute("autoplay", "");
  video.setAttribute("loop", "");

  const setPlaying = (): void => {
    hero.dataset.mediaMode = "video";
  };

  const setStatic = (): void => {
    hero.dataset.mediaMode = "static";
  };

  const tryPlay = (): void => {
    void video
      .play()
      .then(() => {
        if (!video.paused && video.readyState >= 2) setPlaying();
      })
      .catch(() => {
        // Autoplay blocked or asset missing — poster stays visible underneath.
        setStatic();
      });
  };

  const recoverFromMediaError = (): void => {
    const mobile = typeof matchMedia === "function" && matchMedia("(max-width: 47.99rem)").matches;
    if (mobile && !desktopFallback) {
      // Some mobile Chromium decoders reject the vertical encode. Keep motion
      // by retrying the proven desktop reel before falling back to the poster.
      desktopFallback = true;
      pick();
      tryPlay();
      return;
    }
    setStatic();
  };

  video.addEventListener("playing", setPlaying);
  video.addEventListener("error", recoverFromMediaError);
  video.addEventListener("emptied", () => {
    if (video.paused) setStatic();
  });
  video.addEventListener("loadeddata", tryPlay, { once: true });
  tryPlay();

  wireSoundControl(hero, video, doc);

  if (typeof matchMedia === "function") {
    const mql = matchMedia("(max-width: 47.99rem)");
    const onChange = (): void => {
      const was = video.currentTime;
      desktopFallback = false;
      pick();
      if (Number.isFinite(was) && was > 0) {
        try {
          video.currentTime = was;
        } catch {
          /* ignore seek failures on fresh source */
        }
      }
      tryPlay();
    };
    if (typeof mql.addEventListener === "function") mql.addEventListener("change", onChange);
    else if (typeof mql.addListener === "function") mql.addListener(onChange);
  }
}

export function initTerminalPreview(doc: Document, reduced: boolean): void {
  const preview = doc.querySelector<HTMLElement>("[data-terminal-preview]");
  const replay = preview?.querySelector<HTMLButtonElement>("[data-terminal-replay]");
  if (!preview || !replay || reduced) return;

  let endTimer: ReturnType<typeof setTimeout> | undefined;
  const finish = (): void => {
    preview.dataset.crawlState = "field";
    replay.disabled = false;
  };
  const play = (): void => {
    clearTimeout(endTimer);
    preview.dataset.crawlState = "playing";
    replay.disabled = true;
    endTimer = setTimeout(finish, TERMINAL_INTRO_MS);
  };

  replay.addEventListener("click", play);
  if (typeof IntersectionObserver !== "function") {
    play();
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      play();
    },
    { threshold: 0.3 },
  );
  observer.observe(preview);
}

export function initHome(doc: Document = document): void {
  doc.documentElement.classList.add("js");
  const reduced =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  initCinemaHero(doc, reduced);
  initReveals(doc, reduced);
  initTerminalPreview(doc, reduced);
}

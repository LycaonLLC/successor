# ADR-0007: Audio Generation Canon

**Status:** accepted
**Date:** 2026-05-10
**Updated:** 2026-05-10

## Context

Successor needs high-volume effects audio, scalable NPC voice, and music for biome themes, faction motifs, emotional beats, combat layers, trailers, and long-lived live-ops updates. Audio tooling should optimize for fast iteration, easy regeneration, strong manifests, and enough quality to survive real gameplay review.

## Decision

Use a small canonical audio stack:

1. **SFX / VFX-audio:** ElevenLabs Sound Effects API is canonical for generated effects audio.
2. **Voice generation:** ElevenLabs Voice Design / TTS is canonical for generated NPC barks, temp VO, and scalable voice iteration.
3. **Music generation:** Suno is canonical for generated music, including prototype tracks and candidate shipped tracks.

Fallback/augmentation lanes remain available: human performers for major-character acting, composer/music director support for sonic identity and adaptive editing, curated libraries for filler, and Adobe Firefly / Stable Audio / Cartesia / OpenAI / Resemble / local TTS when a canonical lane misses quality, style, language, stem, or production requirements.

Every final audio asset must include manifest metadata for tool, model/version, prompt, seed/request ID when available, hash, tool snapshot, review status, replacement priority, and shipped-asset approval. Final music additionally records `loop_points`, `stems` or `stem_gap_notes`, `theme_family`, and `intensity_state`.

## Rationale

The project needs throughput more than a sprawling vendor matrix. ElevenLabs gives one canonical path for effects audio and voice iteration. Suno gives one canonical path for music exploration and track generation. Narrow defaults make prompts, manifests, QA rubrics, replacement tracking, and A/B tests easier to repeat.

Composer, performer, and library support are production tools, not the default source of every audio asset. Use them where the canonical generator cannot deliver the required performance, identity, stems, loop behavior, language, or mix quality.

## Consequences

Positive:
- Faster audio iteration with fewer provider-specific prompt formats.
- Easier A/B testing because candidates come from stable canonical lanes.
- Simpler manifests and replacement audits.
- Human/composer work focuses on the tracks and performances that actually need it.

Negative:
- Stronger dependency on ElevenLabs for effects/voice and Suno for music.
- Suno outputs may still need editing for loop points, stems, adaptive layers, and mix consistency.
- Major-character VO still needs human performance review; generated voice alone is not automatically production quality.

## Acceptance criteria

- New generated SFX/VFX-audio defaults to ElevenLabs unless a manifest note explains the fallback.
- New generated NPC voice defaults to ElevenLabs unless a manifest note explains the fallback.
- New generated music defaults to Suno unless a manifest note explains the fallback.
- No final shipped audio asset lacks tool snapshot, replacement priority, hash, prompt/tool provenance, and review approval.
- Music manifests include `theme_family`, `intensity_state`, loop points, and stems or `stem_gap_notes`.
- Every final track has an in-engine loop/mix QA pass before approval.

## Related

- `docs/ASSET_PROVENANCE_POLICY.md` — manifest shape.
- `content-pipeline/generated_asset_manifest.schema.json` — audio block including music-specific fields (theme_family, intensity_state, stem_layout, loop_start_ms, loop_end_ms, etc.).
- `content-pipeline/README.md` — canonical audio tooling table.

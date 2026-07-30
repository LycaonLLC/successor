export const successorAudioIds = {
  campfireCrackleLoop: "campfire_crackle_loop",
  creditsChime: "credits_chime",
  doorSlide: "door_slide",
  footstepSingleHifi: "footstep_single_hifi",
  itemTransfer: "item_transfer",
  rainHeavyLoop: "rain_heavy_loop",
  rainLightLoop: "rain_light_loop",
  ricochetPing: "ricochet_ping",
  saberDeflect01: "saber_deflect_01",
  saberDeflect02: "saber_deflect_02",
  saberIdleHum: "saber_idle_hum",
  settlementMurmurLoop: "settlement_murmur_loop",
  surveyPullLoop: "survey_pull_loop",
  uiDeny: "ui_deny",
  musicMenuCharcreateLoop: "music_menu_charcreate_loop",
  musicDesertDayDustSilentWorldLoop: "music_desert_day_dust_silent_world_loop",
  musicDesertNightSleepingCityLoop: "music_desert_night_sleeping_city_loop",
  musicCombatBayouWarDanceLoop: "music_combat_bayou_war_dance_loop",
  musicCombatRedDunesLoop: "music_combat_red_dunes_loop",
  musicCombatSandstormRunLoop: "music_combat_sandstorm_run_loop",
  musicCombatSwampfirePursuitLoop: "music_combat_swampfire_pursuit_loop",
  thunder: ["thunder_01", "thunder_02", "thunder_03", "thunder_04", "thunder_05"],
} as const;

export type SuccessorAudioId = typeof successorAudioIds[keyof Omit<typeof successorAudioIds, "thunder">]
  | typeof successorAudioIds.thunder[number];

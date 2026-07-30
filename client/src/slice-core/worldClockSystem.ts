
export type WorldPhaseId = "deep_night" | "dawn" | "day" | "dusk" | "night";

export interface WorldClockMonth {
  id: string;
  label: string;
  days: number;
}

export interface WorldClockCalendar {
  yearZero: number;
  era: string;
  weekdays: string[];
  months: WorldClockMonth[];
}

export interface WorldClockPhaseWindow {
  id: WorldPhaseId;
  label: string;
  startMinute: number;
  endMinute: number;
}

export interface WorldClockConfig {
  schema: "successor.world-clock.v1";
  configId: string;
  tickRateHz: number;
  realSecondsPerGameDay: number;
  epochTick: number;
  epochDay: number;
  epochMinuteOfDay: number;
  calendar: WorldClockCalendar;
  phases: WorldClockPhaseWindow[];
}

export interface WorldClockSunState {
  elevation: number;
  azimuth: number;
  ambient: number;
  warmth: number;
}

export interface WorldClockMoonState {
  phase: number;
  brightness: number;
}

export interface WorldClockState {
  tick: number;
  dayIndex: number;
  minuteOfDay: number;
  year: number;
  monthIndex: number;
  dayOfMonth: number;
  weekdayIndex: number;
  phase: WorldPhaseId;
  phaseLabel: string;
  phaseProgress: number;
  sun: WorldClockSunState;
  moon: WorldClockMoonState;
}

export interface WorldClockSnapshot extends WorldClockState {
  config?: WorldClockConfig;
}

export interface RuntimeWorldClockState {
  config: WorldClockConfig;
  authoritativeTick: number;
  receivedAtMs: number | null;
  lastSnapshot: WorldClockSnapshot;
}

export interface CreateWorldClockConfigOptions {
  tickRateHz: number;
  realSecondsPerGameDay?: number;
  epochTick?: number;
  epochDay?: number;
  epochMinuteOfDay?: number;
}

const minutesPerDay = 1_440;
const defaultRealSecondsPerGameDay = 300;

export function createWorldClockConfig(options: CreateWorldClockConfigOptions): WorldClockConfig {
  const tickRateHz = positiveFinite(options.tickRateHz, 30);
  const realSecondsPerGameDay = positiveFinite(options.realSecondsPerGameDay, defaultRealSecondsPerGameDay);
  return {
    schema: "successor.world-clock.v1",
    configId: `successor-open-desert-${Math.round(realSecondsPerGameDay)}s-day-v1`,
    tickRateHz,
    realSecondsPerGameDay,
    epochTick: Math.max(0, Math.trunc(options.epochTick ?? 0)),
    epochDay: Math.max(0, Math.trunc(options.epochDay ?? 0)),
    epochMinuteOfDay: floorModulo(Math.trunc(options.epochMinuteOfDay ?? 360), minutesPerDay),
    calendar: {
      yearZero: 1,
      era: "SE",
      weekdays: ["Firstday", "Secondday", "Thirdday", "Fourthday", "Fifthday", "Sixthday", "Restday"],
      months: [
        { id: "cycle-one", label: "First Cycle", days: 30 },
        { id: "cycle-two", label: "Second Cycle", days: 30 },
        { id: "cycle-three", label: "Third Cycle", days: 30 },
        { id: "cycle-four", label: "Fourth Cycle", days: 30 },
        { id: "cycle-five", label: "Fifth Cycle", days: 30 },
        { id: "cycle-six", label: "Sixth Cycle", days: 30 },
      ],
    },
    phases: [
      { id: "deep_night", label: "Deep Night", startMinute: 0, endMinute: 300 },
      { id: "dawn", label: "Dawn", startMinute: 300, endMinute: 420 },
      { id: "day", label: "Day", startMinute: 420, endMinute: 1_080 },
      { id: "dusk", label: "Dusk", startMinute: 1_080, endMinute: 1_200 },
      { id: "night", label: "Night", startMinute: 1_200, endMinute: 1_440 },
    ],
  };
}

export function createRuntimeWorldClock(tickRateHz: number, initialTick: number): RuntimeWorldClockState {
  const config = createWorldClockConfig({ tickRateHz });
  const lastSnapshot = worldClockSnapshot(config, initialTick, true);
  return {
    config,
    authoritativeTick: Math.max(0, Math.trunc(initialTick)),
    receivedAtMs: null,
    lastSnapshot,
  };
}

export function applyWorldClockSnapshot(
  current: RuntimeWorldClockState,
  snapshot: WorldClockSnapshot | undefined,
  receivedAtMs: number,
): RuntimeWorldClockState {
  if (!snapshot) return current;
  const config = snapshot.config ?? current.config;
  const normalized = normalizeWorldClockSnapshot(config, snapshot);
  return {
    config,
    authoritativeTick: normalized.tick,
    receivedAtMs,
    lastSnapshot: normalized,
  };
}

export function projectedWorldClockState(clock: RuntimeWorldClockState, worldTimeMs: number): WorldClockState {
  const elapsedMs = clock.receivedAtMs === null ? Math.max(0, worldTimeMs) : Math.max(0, worldTimeMs - clock.receivedAtMs);
  const projectedTick = clock.authoritativeTick + (elapsedMs / 1000) * clock.config.tickRateHz;
  return worldClockStateAtTick(clock.config, projectedTick);
}

export function projectedWorldClockForState(state: { worldClock: RuntimeWorldClockState; worldTimeMs: number }): WorldClockState {
  return projectedWorldClockState(state.worldClock, state.worldTimeMs);
}

export function worldClockStateAtTick(config: WorldClockConfig, tick: number): WorldClockState {
  const safeTick = Math.max(0, Math.trunc(tick));
  const ticksPerDay = ticksPerGameDay(config);
  const elapsedTicks = Math.max(0, safeTick - config.epochTick);
  const totalMinutes = config.epochDay * minutesPerDay
    + config.epochMinuteOfDay
    + (elapsedTicks / ticksPerDay) * minutesPerDay;
  const absoluteMinute = Math.floor(totalMinutes);
  const dayIndex = Math.floor(absoluteMinute / minutesPerDay);
  const minuteOfDay = floorModulo(absoluteMinute, minutesPerDay);
  const phaseWindow = phaseForMinute(config, minuteOfDay);
  const phaseSpan = Math.max(1, phaseWindow.endMinute - phaseWindow.startMinute);
  const phaseProgress = clamp01((minuteOfDay - phaseWindow.startMinute) / phaseSpan);
  const calendarDate = calendarDateForDay(config.calendar, dayIndex);
  return {
    tick: safeTick,
    dayIndex,
    minuteOfDay,
    year: calendarDate.year,
    monthIndex: calendarDate.monthIndex,
    dayOfMonth: calendarDate.dayOfMonth,
    weekdayIndex: calendarDate.weekdayIndex,
    phase: phaseWindow.id,
    phaseLabel: phaseWindow.label,
    phaseProgress: round3(phaseProgress),
    sun: sunStateForMinute(minuteOfDay),
    moon: moonStateForDay(dayIndex, minuteOfDay),
  };
}

export function worldClockSnapshot(config: WorldClockConfig, tick: number, includeConfig = false): WorldClockSnapshot {
  const state = worldClockStateAtTick(config, tick);
  return includeConfig ? { ...state, config } : state;
}

export function ticksPerGameDay(config: Pick<WorldClockConfig, "tickRateHz" | "realSecondsPerGameDay">): number {
  return Math.max(1, config.tickRateHz * config.realSecondsPerGameDay);
}

export function formatWorldClock(state: Pick<WorldClockState, "minuteOfDay">): string {
  const hours = Math.floor(state.minuteOfDay / 60);
  const minutes = state.minuteOfDay % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

export function formatWorldDate(config: WorldClockConfig, state: Pick<WorldClockState, "year" | "monthIndex" | "dayOfMonth">): string {
  const month = config.calendar.months[state.monthIndex] ?? config.calendar.months[0];
  return `${month?.label ?? "Month"} ${state.dayOfMonth}, ${state.year} ${config.calendar.era}`;
}

export function phaseLightClass(phase: WorldPhaseId): string {
  return `world-phase-${phase}`;
}

function normalizeWorldClockSnapshot(config: WorldClockConfig, snapshot: WorldClockSnapshot): WorldClockSnapshot {
  if (snapshot.config) return snapshot;
  const derived = worldClockSnapshot(config, snapshot.tick, false);
  return {
    ...derived,
    ...snapshot,
    sun: snapshot.sun ?? derived.sun,
    moon: snapshot.moon ?? derived.moon,
  };
}

function calendarDateForDay(calendar: WorldClockCalendar, dayIndex: number): {
  year: number;
  monthIndex: number;
  dayOfMonth: number;
  weekdayIndex: number;
} {
  const yearLength = Math.max(1, calendar.months.reduce((total, month) => total + Math.max(1, month.days), 0));
  const yearOffset = Math.floor(dayIndex / yearLength);
  let dayInYear = floorModulo(dayIndex, yearLength);
  let monthIndex = 0;
  for (let index = 0; index < calendar.months.length; index += 1) {
    const monthDays = Math.max(1, calendar.months[index]?.days ?? 1);
    if (dayInYear < monthDays) {
      monthIndex = index;
      break;
    }
    dayInYear -= monthDays;
  }
  return {
    year: calendar.yearZero + yearOffset,
    monthIndex,
    dayOfMonth: dayInYear + 1,
    weekdayIndex: floorModulo(dayIndex, Math.max(1, calendar.weekdays.length)),
  };
}

function phaseForMinute(config: WorldClockConfig, minuteOfDay: number): WorldClockPhaseWindow {
  return config.phases.find((phase) => minuteOfDay >= phase.startMinute && minuteOfDay < phase.endMinute)
    ?? config.phases[0]
    ?? { id: "day", label: "Day", startMinute: 0, endMinute: minutesPerDay };
}

function sunStateForMinute(minuteOfDay: number): WorldClockSunState {
  const solarRadians = ((minuteOfDay - 360) / 720) * Math.PI;
  const elevation = Math.sin(solarRadians);
  const daylight = smoothstep(-0.08, 0.18, elevation);
  const dawnDuskWarmth = Math.max(0, 1 - Math.abs(minuteOfDay - 360) / 170, 1 - Math.abs(minuteOfDay - 1_080) / 170);
  const nightCold = 1 - daylight;
  return {
    elevation: round3(elevation),
    azimuth: round3((minuteOfDay / minutesPerDay) * Math.PI * 2 - Math.PI / 2),
    ambient: round3(0.2 + daylight * 0.8),
    warmth: round3(clamp(dawnDuskWarmth * 0.85 - nightCold * 0.42, -0.42, 0.85)),
  };
}

function moonStateForDay(dayIndex: number, minuteOfDay: number): WorldClockMoonState {
  const phase = floorModulo(dayIndex, 28) / 28;
  const fullness = 1 - Math.abs(phase - 0.5) * 2;
  const nightFactor = 1 - smoothstep(300, 420, minuteOfDay) * (1 - smoothstep(1_080, 1_200, minuteOfDay));
  return {
    phase: round3(phase),
    brightness: round3(clamp((0.16 + fullness * 0.52) * nightFactor, 0, 0.72)),
  };
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function floorModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

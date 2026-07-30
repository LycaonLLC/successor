export const DESKTOP_SMOKE_PORT_RANGE = Object.freeze({ start: 29_700, end: 29_799 });

export function boundedEnvPort(name, fallback, environment = process.env) {
  const raw = environment[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < DESKTOP_SMOKE_PORT_RANGE.start || value > DESKTOP_SMOKE_PORT_RANGE.end) {
    throw new Error(`${name}=${raw} outside lane port block ${DESKTOP_SMOKE_PORT_RANGE.start}-${DESKTOP_SMOKE_PORT_RANGE.end}`);
  }
  return value;
}

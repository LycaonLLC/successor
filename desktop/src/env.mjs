export function successorDesktopEnv(name) {
  return process.env[`SUCCESSOR_DESKTOP_${name}`];
}

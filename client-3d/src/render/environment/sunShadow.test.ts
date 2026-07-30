import { describe, expect, it, vi } from "vitest";
import { BoxGeometry, Color, Matrix4, Mesh, MeshBasicMaterial, Scene, Texture, Vector2, Vector3 } from "three";
import { createWorldClockConfig, ticksPerGameDay, worldClockStateAtTick } from "@successor/client/src/slice-core/worldClockSystem";
import { SUCCESSOR_3D_CONFIG } from "../../config";
import { markSunShadowCaster, SunShadowSystem } from "./sunShadow";

const MINUTES_PER_DAY = 1_440;
function sunDirAtMinute(minuteOfDay: number): { x: number; z: number; screenX: number; screenY: number } {
  const clockConfig = createWorldClockConfig({ tickRateHz: 30 });
  const minuteDelta = ((minuteOfDay - clockConfig.epochMinuteOfDay) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const tick = clockConfig.epochTick + (minuteDelta / MINUTES_PER_DAY) * ticksPerGameDay(clockConfig);
  const clock = worldClockStateAtTick(clockConfig, tick);
  const sunConfig = SUCCESSOR_3D_CONFIG.environment.sun;
  const azimuth = clock.sun.azimuth + sunConfig.azimuthWorldOffsetRad;
  const elevation = Math.max(Math.asin(Math.max(-1, Math.min(1, clock.sun.elevation))), sunConfig.minShadowElevationDeg * Math.PI / 180);
  const cosElevation = Math.cos(elevation);
  const x = -Math.cos(azimuth) * cosElevation;
  const z = -Math.sin(azimuth) * cosElevation;

  return {
    x,
    z,
    screenX: x,
    screenY: z,
  };
}

describe("sun shadow azimuth calibration", () => {
  it("keeps server clock bearings in the north-up screen compass", () => {
    const sunrise = sunDirAtMinute(360);
    const noon = sunDirAtMinute(720);
    const dusk = sunDirAtMinute(1080);

    expect(sunrise.screenX).toBeLessThan(-0.95);
    expect(Math.abs(sunrise.screenY)).toBeLessThan(0.001);
    expect(Math.abs(noon.x)).toBeLessThan(0.001);
    expect(noon.z).toBeLessThan(0);
    expect(noon.screenY).toBeLessThan(0);
    expect(dusk.screenX).toBeGreaterThan(0.95);
    expect(Math.abs(dusk.screenY)).toBeLessThan(0.001);
  });
});

describe("SunShadowSystem receiver patch", () => {
  it("injects the shared receiver uniforms and updates them from the sun pass", () => {
    const system = new SunShadowSystem();
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: `
        #include <common>
        void main() {
          vec3 transformed = position;
          #include <project_vertex>
        }
      `,
      fragmentShader: `
        #include <common>
        void main() {
          gl_FragColor = vec4(1.0);
          #include <fog_fragment>
        }
      `,
    };

    try {
      system.injectReceiver(shader);

      expect(shader.uniforms.successorSunShadowMap).toBeDefined();
      expect(shader.uniforms.successorSunShadowMatrix?.value).toBeInstanceOf(Matrix4);
      expect(shader.uniforms.successorSunShadowTexelSize?.value).toBeInstanceOf(Vector2);
      expect(shader.vertexShader).toContain("vSuccessorSunShadowCoord");
      const shadowApplyIndex = shader.fragmentShader.indexOf("gl_FragColor.rgb *= 1.0 - successorSunShadowStrength * successorSunShadowFactor();");
      const fogIndex = shader.fragmentShader.indexOf("#include <fog_fragment>");
      expect(shadowApplyIndex).toBeGreaterThan(-1);
      expect(fogIndex).toBeGreaterThan(shadowApplyIndex);

      system.update({
        sun: {
          dir: new Vector3(-1, -0.35, -1).normalize(),
          shadowStrength01: 0.25,
        },
      } as Parameters<SunShadowSystem["update"]>[0], 10.25, -4.5);

      expect(shader.uniforms.successorSunShadowMap?.value).toBeInstanceOf(Texture);
      expect(shader.uniforms.successorSunShadowStrength?.value).toBe(0.25);
      const texelSize = shader.uniforms.successorSunShadowTexelSize?.value as Vector2;
      expect(texelSize.x).toBeCloseTo(1 / SUCCESSOR_3D_CONFIG.environment.shadow.mapSize, 8);
      expect(texelSize.y).toBeCloseTo(1 / SUCCESSOR_3D_CONFIG.environment.shadow.mapSize, 8);

      system.update({
        sun: {
          dir: new Vector3(-1, -0.35, -1).normalize(),
          shadowStrength01: 0,
        },
      } as Parameters<SunShadowSystem["update"]>[0], 10.25, -4.5);
      expect(shader.uniforms.successorSunShadowStrength?.value).toBe(0);
      expect(texelSize.x).toBe(0);
      expect(texelSize.y).toBe(0);
    } finally {
      system.dispose();
    }
  });
});

describe("SunShadowSystem render pass", () => {
  it("renders only when active and restores scene/renderer state", () => {
    vi.stubGlobal("window", {});
    const system = new SunShadowSystem();
    const scene = new Scene();
    const caster = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    const nonCaster = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    markSunShadowCaster(caster);
    scene.add(caster);
    scene.add(nonCaster);

    let renderCount = 0;
    let clearCount = 0;
    let renderedWithOverride = false;
    let restoredClear = false;
    const renderer = {
      getRenderTarget: () => null,
      getClearAlpha: () => 0.65,
      getClearColor: (target: Color) => target.set(0x123456),
      setRenderTarget: () => {},
      setClearColor: (color: Color | number | string, alpha?: number) => {
        if (color instanceof Color && color.getHex() === 0x123456 && alpha === 0.65) restoredClear = true;
      },
      clear: () => {
        clearCount += 1;
      },
      render: () => {
        renderCount += 1;
        renderedWithOverride = scene.overrideMaterial !== null;
      },
    } as unknown as Parameters<SunShadowSystem["render"]>[0];

    try {
      system.update({
        sun: {
          dir: new Vector3(-1, -0.35, -1).normalize(),
          shadowStrength01: 0.4,
        },
      } as Parameters<SunShadowSystem["update"]>[0], 2, 3);
      system.render(renderer, scene);

      expect(renderCount).toBe(1);
      expect(clearCount).toBe(1);
      expect(renderedWithOverride).toBe(true);
      expect(restoredClear).toBe(true);
      expect(scene.overrideMaterial).toBeNull();
      expect(window.__successor3dSunShadow?.casterCount).toBe(1);

      system.update({
        sun: {
          dir: new Vector3(-1, -0.35, -1).normalize(),
          shadowStrength01: 0,
        },
      } as Parameters<SunShadowSystem["update"]>[0], 2, 3);
      system.render(renderer, scene);
      expect(renderCount).toBe(1);
      expect(window.__successor3dSunShadow?.strength).toBe(0);
    } finally {
      system.dispose();
      caster.geometry.dispose();
      nonCaster.geometry.dispose();
      (caster.material as MeshBasicMaterial).dispose();
      (nonCaster.material as MeshBasicMaterial).dispose();
      vi.unstubAllGlobals();
    }
  });
});

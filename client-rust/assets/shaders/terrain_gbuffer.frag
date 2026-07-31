// World-space procedural-tile terrain material. Macro controls stream per chunk;
// reusable PBR tile arrays provide scale-stable close detail.
in vec3 v_normal;
in vec2 v_uv;
in vec3 v_worldPos;
in vec4 v_color;

uniform sampler2D u_terrainControl;
uniform sampler2DArray u_terrainAlbedo;
uniform sampler2DArray u_terrainNrma;
uniform vec2 u_terrainOrigin;
uniform float u_terrainWorldSize;
uniform float u_terrainTileScale;
uniform float u_terrainNormalStrength;
uniform vec3 u_camEye;

layout(location = 0) out vec4 gb0;
layout(location = 1) out vec4 gb1;
layout(location = 2) out vec4 gb2;
layout(location = 3) out vec4 gb3;

vec2 encodeOctahedral(vec3 normal) {
    normal /= abs(normal.x) + abs(normal.y) + abs(normal.z);
    vec2 encoded = normal.xy;
    if (normal.z < 0.0) {
        encoded = (1.0 - abs(encoded.yx)) * sign(encoded.xy);
    }
    return encoded * 0.5 + 0.5;
}

vec2 hash2(vec2 p) {
    vec2 h = vec2(
        dot(p, vec2(127.1, 311.7)),
        dot(p, vec2(269.5, 183.3))
    );
    return fract(sin(h) * 43758.5453);
}

float worldNoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    vec2 smoothF = f * f * (3.0 - 2.0 * f);
    float a = hash2(cell).x;
    float b = hash2(cell + vec2(1.0, 0.0)).x;
    float c = hash2(cell + vec2(0.0, 1.0)).x;
    float d = hash2(cell + vec2(1.0, 1.0)).x;
    return mix(mix(a, b, smoothF.x), mix(c, d, smoothF.x), smoothF.y);
}

vec2 variantUv(vec2 uv, float variant) {
    if (variant < 0.5) return uv;
    if (variant < 1.5) return vec2(-uv.y, uv.x);
    if (variant < 2.5) return -uv;
    return vec2(uv.y, -uv.x);
}

vec2 variantNormal(vec2 normalXy, float variant) {
    if (variant < 0.5) return normalXy;
    if (variant < 1.5) return vec2(normalXy.y, -normalXy.x);
    if (variant < 2.5) return -normalXy;
    return vec2(-normalXy.y, normalXy.x);
}

void sampleVariant(float surface, vec2 worldUv, vec2 cell, out vec3 albedo, out vec4 nrma) {
    vec2 random = hash2(cell + vec2(surface * 19.19, surface * 7.73));
    float variant = min(floor(random.x * 8.0), 7.0);
    float orientation = mod(variant, 4.0);
    vec2 uv = variantUv(worldUv + random.yx * 23.0, orientation);
    float layer = surface * 8.0 + variant;
    albedo = texture(u_terrainAlbedo, vec3(uv, layer)).rgb;
    nrma = texture(u_terrainNrma, vec3(uv, layer));
    vec2 normalXy = variantNormal(nrma.rg * 2.0 - 1.0, orientation);
    nrma.rg = normalXy * 0.5 + 0.5;
}

void sampleSurface(float surface, vec2 worldUv, out vec3 albedo, out vec4 nrma) {
    // A large triangular lattice chooses three stable random tile transforms.
    // Sharpened barycentric weights keep transitions continuous without the
    // wide two-texture cross-fades that made the old surface look smeared.
    vec2 lattice = worldUv * 0.22;
    vec2 cell = floor(lattice);
    vec2 f = fract(lattice);
    vec2 c0;
    vec2 c1;
    vec2 c2;
    vec3 weights;
    if (f.x + f.y < 1.0) {
        c0 = cell;
        c1 = cell + vec2(1.0, 0.0);
        c2 = cell + vec2(0.0, 1.0);
        weights = vec3(1.0 - f.x - f.y, f.x, f.y);
    } else {
        c0 = cell + vec2(1.0, 1.0);
        c1 = cell + vec2(0.0, 1.0);
        c2 = cell + vec2(1.0, 0.0);
        weights = vec3(f.x + f.y - 1.0, 1.0 - f.x, 1.0 - f.y);
    }
    weights *= weights;
    weights *= weights;
    weights *= weights;
    weights /= dot(weights, vec3(1.0));

    vec3 a0;
    vec3 a1;
    vec3 a2;
    vec4 n0;
    vec4 n1;
    vec4 n2;
    sampleVariant(surface, worldUv, c0, a0, n0);
    sampleVariant(surface, worldUv, c1, a1, n1);
    sampleVariant(surface, worldUv, c2, a2, n2);
    albedo = a0 * weights.x + a1 * weights.y + a2 * weights.z;
    nrma = n0 * weights.x + n1 * weights.y + n2 * weights.z;
}

void main() {
    // Low-frequency nonperiodic world fields vary surface coverage without
    // inheriting chunk boundaries or introducing a visible repeat interval.
    float macroA = worldNoise(v_worldPos.xz * 0.025 + vec2(13.7, -5.1)) * 2.0 - 1.0;
    float macroB = worldNoise(v_worldPos.xz * 0.055 + vec2(-8.3, 21.4)) * 2.0 - 1.0;
    float macroC = worldNoise(v_worldPos.xz * 0.11 + vec2(37.1, 4.6)) * 2.0 - 1.0;
    vec3 weights = vec3(
        0.45 + macroA * 0.40,
        0.30 + macroB * 0.35,
        0.25 + macroC * 0.30
    );
    weights = max(weights, vec3(0.03));
    weights /= dot(weights, vec3(1.0));
    vec2 worldUv = v_worldPos.xz / u_terrainTileScale;

    vec3 albedo0;
    vec3 albedo1;
    vec3 albedo2;
    vec4 nrma0;
    vec4 nrma1;
    vec4 nrma2;
    sampleSurface(0.0, worldUv, albedo0, nrma0);
    sampleSurface(1.0, worldUv, albedo1, nrma1);
    sampleSurface(2.0, worldUv, albedo2, nrma2);
    vec3 albedo = albedo0 * weights.x + albedo1 * weights.y + albedo2 * weights.z;
    vec4 nrma = nrma0 * weights.x + nrma1 * weights.y + nrma2 * weights.z;
    float microA = worldNoise(v_worldPos.xz * 3.7 + vec2(17.3, -9.1)) * 2.0 - 1.0;
    float microB = worldNoise(v_worldPos.xz * 10.9 + vec2(-4.7, 31.2)) * 2.0 - 1.0;
    float microDetail = microA * 0.72 + microB * 0.28;
    float microFade = 1.0 - smoothstep(35.0, 120.0, distance(v_worldPos, u_camEye));
    albedo *= 1.0 + microDetail * 0.16 * microFade;

    float macroTint = 1.0 + (macroA * 0.55 + macroB * 0.30 + macroC * 0.15) * 0.18;
    float detailFade = 1.0 - smoothstep(45.0, 150.0, distance(v_worldPos, u_camEye));
    vec2 normalXz = (nrma.rg * 2.0 - 1.0) * u_terrainNormalStrength * detailFade;
    vec3 worldNormal = normalize(vec3(normalXz.x, 1.0, normalXz.y));
    float roughness = clamp(nrma.b, 0.045, 1.0);
    float ao = clamp(nrma.a, 0.0, 1.0);

    gb0 = vec4(albedo, 0.0);
    gb1 = vec4(encodeOctahedral(worldNormal), roughness, ao);
    gb2 = vec4(0.0, 0.0, 0.0, 1.0 / 255.0);
    float dielectricF0 = 0.04;
    gb3 = vec4(0.0, 0.045, dielectricF0, 0.0);
}

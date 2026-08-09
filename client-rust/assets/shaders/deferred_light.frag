// Deferred sun lighting: reconstruct world position from depth, decode the
// G-buffer, evaluate a Cook-Torrance PBR sun term with soft shadows, add
// ambient (VXGI cone trace when GI_CONES>0, else a hemisphere floor), then fog.
// Tier behavior is compile-time via SHADOW_TAPS / PCSS / GI_CONES / GI_SPECULAR
// (#define lines prepended by the renderer). Pairs with post.vert.
#ifndef SHADOW_TAPS
#define SHADOW_TAPS 12
#endif
#ifndef PCSS
#define PCSS 0
#endif
#ifndef GI_CONES
#define GI_CONES 0
#endif
#ifndef GI_SPECULAR
#define GI_SPECULAR 0
#endif

in vec2 v_uv;

uniform sampler2D u_gb0;
uniform sampler2D u_gb1;
uniform sampler2D u_gb2;
uniform sampler2D u_gb3;
uniform sampler2D u_depth;
uniform sampler2D u_shadowMap;
#if GI_CONES > 0
uniform sampler3D u_gi;
uniform vec3 u_giOrigin;
uniform int u_giReady;
uniform vec3 u_giValidMin;
uniform vec3 u_giValidMax;
uniform float u_giBlend;
uniform float u_giCell;
uniform float u_giStrength;
#endif

uniform mat4 u_invViewProj;
uniform mat4 u_lightViewProj;
uniform vec3 u_lightDir;
uniform vec3 u_lightColor;
uniform vec3 u_camEye;
uniform float u_ambient;
uniform vec3 u_fogColor;
uniform float u_fogNear;
uniform float u_fogFar;
uniform float u_shadowTexelUV;    // 1.0 / shadow map size
uniform float u_shadowWorldTexel; // world units per shadow texel (normal offset)
uniform float u_sunPenumbraScale; // PCSS penumbra gain
uniform float u_exposure;
uniform float u_shadowDepthBias;
uniform float u_shadowNormalBias;
uniform float u_emissiveScalar;
uniform float u_aoIntensity;

out vec4 frag;

const float GI_SIZE = 64.0;

vec3 decodeOctahedral(vec2 encoded) {
    vec2 f = encoded * 2.0 - 1.0;
    vec3 normal = vec3(f, 1.0 - abs(f.x) - abs(f.y));
    float fold = clamp(-normal.z, 0.0, 1.0);
    normal.xy += vec2(normal.x >= 0.0 ? -fold : fold, normal.y >= 0.0 ? -fold : fold);
    return normalize(normal);
}
// 16-entry Poisson disk (unit radius).
const vec2 POISSON[16] = vec2[16](
    vec2(-0.94201624, -0.39906216), vec2(0.94558609, -0.76890725),
    vec2(-0.094184101, -0.92938870), vec2(0.34495938, 0.29387760),
    vec2(-0.91588581, 0.45771432), vec2(-0.81544232, -0.87912464),
    vec2(-0.38277543, 0.27676845), vec2(0.97484398, 0.75648379),
    vec2(0.44323325, -0.97511554), vec2(0.53742981, -0.47373420),
    vec2(-0.26496911, -0.41893023), vec2(0.79197514, 0.19090188),
    vec2(-0.24188840, 0.99706507), vec2(-0.81409955, 0.91437590),
    vec2(0.19984126, 0.78641367), vec2(0.14383161, -0.14100790)
);

float ign(vec2 p) {
    // Interleaved gradient noise -> [0, 2pi) rotation.
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))) * 6.2831853;
}


float sampleShadow(vec2 uv, float compare) {
    float d = texture(u_shadowMap, uv).r;
    return compare > d ? 0.0 : 1.0;
}

float softShadow(vec3 P, vec3 N, float NdotL) {
    vec4 lp = u_lightViewProj * vec4(P + N * u_shadowWorldTexel * u_shadowNormalBias, 1.0);
    vec3 proj = lp.xyz / lp.w;
    proj = proj * 0.5 + 0.5;
    if (proj.z > 1.0) return 1.0;
    float bias = clamp(u_shadowDepthBias * tan(acos(clamp(NdotL, 0.0, 1.0))), 0.0, 0.05);
    float zR = proj.z - bias;
    float ang = ign(gl_FragCoord.xy);
    float ca = cos(ang), sa = sin(ang);
    mat2 rot = mat2(ca, -sa, sa, ca);

    float radius = 2.0 * u_shadowTexelUV;
#if PCSS
    // Blocker search (8 taps) -> average blocker depth -> penumbra.
    float bsum = 0.0; float bcount = 0.0;
    for (int i = 0; i < 8; i++) {
        vec2 o = rot * POISSON[i] * (4.0 * u_shadowTexelUV);
        float d = texture(u_shadowMap, proj.xy + o).r;
        if (d < zR) { bsum += d; bcount += 1.0; }
    }
    if (bcount < 0.5) return 1.0;
    float zB = bsum / bcount;
    float pen = (zR - zB) / max(zB, 1e-4) * u_sunPenumbraScale;
    radius = clamp(pen, 0.5, 6.0) * u_shadowTexelUV;
#endif

    float sum = 0.0;
    for (int i = 0; i < SHADOW_TAPS; i++) {
        vec2 o = rot * POISSON[i] * radius;
        sum += sampleShadow(proj.xy + o, zR);
    }
    return sum / float(SHADOW_TAPS);
}

#if GI_CONES > 0
vec4 coneTrace(vec3 origin, vec3 dir, float aperture) {
    vec4 acc = vec4(0.0);
    float t = u_giCell;
    for (int i = 0; i < 5; i++) {
        float d = max(aperture * t, u_giCell);
        float mip = max(log2(d / u_giCell), 0.0);
        vec3 pos = origin + dir * t;
        if (u_giReady == 0 || any(lessThan(pos, u_giValidMin)) || any(greaterThan(pos, u_giValidMax))) break;
        vec3 uvw = vec3(
            fract(pos.x / (GI_SIZE * u_giCell)),
            (pos.y - u_giOrigin.y) / (GI_SIZE * u_giCell),
            fract(pos.z / (GI_SIZE * u_giCell))
        );
        if (uvw.y < 0.0 || uvw.y > 1.0) break;
        vec4 s = textureLod(u_gi, uvw, mip);
        acc.rgb += (1.0 - acc.a) * s.a * s.rgb;
        acc.a += (1.0 - acc.a) * s.a;
        if (acc.a > 0.95) break;
        t *= 1.7;
    }
    return acc;
}

// Distance (world units) from P to the nearest currently valid face.
float volumeBorderDist(vec3 P) {
    vec3 lo = P - u_giValidMin;
    vec3 hi = u_giValidMax - P;
    return min(min(min(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
}

vec3 diffuseGI(vec3 P, vec3 N, out float ao) {
    vec3 up = abs(N.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 T = normalize(cross(up, N));
    vec3 B = cross(N, T);
    vec3 origin = P + N * (0.5 * u_giCell);
    vec3 irr = vec3(0.0);
    float occ = 0.0;
    // Central cone along the normal.
    vec4 c0 = coneTrace(origin, N, 0.577);
    irr += c0.rgb; occ += c0.a;
    // Side cones tilted ~55deg, uniformly around the normal.
    float tilt = 0.9599; // ~55deg
    for (int i = 1; i < GI_CONES; i++) {
        float az = 6.2831853 * float(i - 1) / float(GI_CONES - 1);
        vec3 dir = normalize(N * cos(tilt) + (T * cos(az) + B * sin(az)) * sin(tilt));
        vec4 c = coneTrace(origin, dir, 0.577);
        irr += c.rgb * 0.7; occ += c.a * 0.7;
    }
    float norm = 1.0 + 0.7 * float(GI_CONES - 1);
    ao = clamp(1.0 - occ / norm, 0.0, 1.0);
    return irr / norm;
}
#endif

void main() {
    float depth = texture(u_depth, v_uv).r;
    if (depth >= 1.0) {
        frag = vec4(u_fogColor * u_exposure, 1.0);
        return;
    }
    vec4 clip = vec4(v_uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 wp = u_invViewProj * clip;
    vec3 P = wp.xyz / wp.w;

    vec4 g0 = texture(u_gb0, v_uv);
    vec4 g1 = texture(u_gb1, v_uv);
    vec4 g2 = texture(u_gb2, v_uv);
    vec4 g3 = texture(u_gb3, v_uv);
    vec3 emission = g2.rgb * g2.a * 32.0 * u_emissiveScalar;
    float materialAo = g1.a;
    float clearcoat = g3.r;
    float clearcoatRoughness = clamp(g3.g, 0.045, 1.0);
    float dielectricF0 = g3.b;
    vec3 albedo = g0.rgb;
    float metallic = g0.a;
    vec3 N = decodeOctahedral(g1.rg);
    float roughness = clamp(g1.b, 0.045, 1.0);
    vec3 V = normalize(u_camEye - P);
    vec3 L = normalize(-u_lightDir);
    float NdotL = max(dot(N, L), 0.0);
    vec3 F;
    vec3 baseLobe = pbrBaseLobe(
        albedo,
        metallic,
        roughness,
        dielectricF0,
        N,
        V,
        L,
        F
    );
    float clearcoatFresnel = 0.0;
    vec3 clearcoatLobe = pbrClearcoatLobe(
        clearcoat,
        clearcoatRoughness,
        N,
        V,
        L,
        clearcoatFresnel
    );
    float shadow = (NdotL > 0.0) ? softShadow(P, N, NdotL) : 1.0;
    vec3 direct = (
        baseLobe * (1.0 - clearcoat * clearcoatFresnel)
        + clearcoatLobe
    ) * u_lightColor * NdotL * shadow;

    // Ambient / GI.
    float ao = 1.0;
    vec3 ambient;
#if GI_CONES > 0
    vec3 hemi = u_ambient * albedo;
    if (u_giReady != 0) {
    float gao;
    vec3 irr = diffuseGI(P, N, gao);
    ao = gao;
    vec3 giAmbient = irr * albedo * u_giStrength + hemi * mix(0.7, 1.0, ao);
    float border = clamp(volumeBorderDist(P) / (4.0 * u_giCell), 0.0, 1.0);
        float giWeight = border * u_giBlend;
        ambient = mix(hemi, giAmbient, giWeight);
#if GI_SPECULAR
    vec3 R = reflect(-V, N);
        vec4 sgi = coneTrace(P + N * (0.5 * u_giCell), R, mix(0.05, 0.6, roughness));
        ambient += sgi.rgb * F * u_giStrength * giWeight;
#endif
    } else {
        ambient = hemi;
    }
#else
    ambient = u_ambient * albedo;
#endif

    ambient *= pow(clamp(materialAo * ao, 0.001, 1.0), u_aoIntensity);
    // Sun occlusion also attenuates broad indirect light enough for small,
    // animated casters to remain readable against bright gameplay terrain.
    ambient *= mix(0.60, 1.0, shadow);

    vec3 color = direct + ambient + emission;

    float fogD = distance(P, u_camEye);
    float fogF = clamp((fogD - u_fogNear) / max(1.0, u_fogFar - u_fogNear), 0.0, 1.0);
    color = mix(color, u_fogColor, fogF);

    frag = vec4(color * u_exposure, 1.0);
}

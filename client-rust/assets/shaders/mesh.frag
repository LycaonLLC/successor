// Forward material shader used by RTT and sorted transparent scene draws.
in vec3 v_normal;
in vec4 v_lightPos;
in vec2 v_uv;
in vec3 v_worldPos;

uniform vec3 u_lightDir;
uniform vec3 u_lightColor;
uniform vec4 u_color;      // rgb + alpha (alpha < 1 => dithered)
uniform float u_ambient;
uniform sampler2D u_shadowMap;
uniform int u_useShadow;
uniform sampler2D u_albedo;
uniform int u_hasTex;
uniform sampler2D u_aoTex;
uniform sampler2D u_emissiveTex;
uniform int u_hasAoTex;
uniform int u_hasEmissiveTex;
uniform float u_aoStrength;
uniform float u_aoIntensity;
uniform vec3 u_emissiveFactor;
uniform float u_emissiveStrength;
uniform vec3 u_camEye;
uniform vec3 u_fogColor;
uniform float u_fogNear;
uniform float u_fogFar;
uniform sampler2D u_sceneCopy;
uniform sampler2D u_opaqueDepth;
uniform vec2 u_screenSize;
uniform int u_transparentPass;
uniform float u_transmission;
uniform float u_ior;
uniform float u_metallic;
uniform float u_roughness;
uniform float u_dielectricF0;
uniform float u_clearcoat;
uniform float u_clearcoatRoughness;
uniform int u_pointCount;
uniform vec3 u_pointPositions[32];
uniform float u_pointRadii[32];
uniform vec3 u_pointColors[32];
uniform float u_pointIntensities[32];

out vec4 frag;


float shadowFactor(vec4 lp) {
    vec3 proj = lp.xyz / lp.w;
    proj = proj * 0.5 + 0.5;
    if (proj.z > 1.0) return 1.0;
    float bias = 0.0025;
    vec2 texel = vec2(1.0 / 2048.0);
    float sum = 0.0;
    for (int x = -1; x <= 1; x++) {
        for (int y = -1; y <= 1; y++) {
            float d = texture(u_shadowMap, proj.xy + vec2(float(x), float(y)) * texel).r;
            sum += (proj.z - bias > d) ? 0.0 : 1.0;
        }
    }
    return sum / 9.0;
}

void main() {
    vec2 screenUv = gl_FragCoord.xy / u_screenSize;
    if (u_transparentPass == 1) {
        float opaqueDepth = texture(u_opaqueDepth, screenUv).r;
        if (gl_FragCoord.z > opaqueDepth + 0.00001) discard;
    }
    vec3 n = normalize(v_normal);
    vec3 viewDir = normalize(u_camEye - v_worldPos);
    vec3 sunDir = normalize(-u_lightDir);
    float nDotSun = max(dot(n, sunDir), 0.0);
    float sh = (u_useShadow == 1) ? shadowFactor(v_lightPos) : 1.0;
    vec4 base = u_color;
    if (u_hasTex == 1) base *= texture(u_albedo, v_uv);
    float aoSample = u_hasAoTex == 1 ? texture(u_aoTex, v_uv).r : 1.0;
    float materialAo = 1.0 + clamp(u_aoStrength, 0.0, 1.0) * (aoSample - 1.0);
    float ao = pow(clamp(materialAo, 0.001, 1.0), max(u_aoIntensity, 0.0));
    vec3 emission = u_emissiveFactor * u_emissiveStrength;
    if (u_hasEmissiveTex == 1) emission *= texture(u_emissiveTex, v_uv).rgb;
    vec3 fresnel;
    vec3 sunBrdf = pbrBaseLobe(
        base.rgb, u_metallic, u_roughness, u_dielectricF0,
        n, viewDir, sunDir, fresnel
    );
    float coatFresnel;
    vec3 coat = pbrClearcoatLobe(
        u_clearcoat, u_clearcoatRoughness, n, viewDir, sunDir, coatFresnel
    );
    vec3 lit = base.rgb * u_ambient * ao
        + (sunBrdf * (1.0 - coatFresnel * u_clearcoat) + coat)
            * u_lightColor * nDotSun * sh;
    for (int index = 0; index < 32; index++) {
        if (index >= u_pointCount) break;
        vec3 toLight = u_pointPositions[index] - v_worldPos;
        float distanceToLight = length(toLight);
        float radius = max(u_pointRadii[index], 0.001);
        float attenuation = max(1.0 - distanceToLight / radius, 0.0);
        attenuation *= attenuation;
        vec3 pointDir = toLight / max(distanceToLight, 0.001);
        float nDotPoint = max(dot(n, pointDir), 0.0);
        vec3 pointFresnel;
        vec3 pointBrdf = pbrBaseLobe(
            base.rgb, u_metallic, u_roughness, u_dielectricF0,
            n, viewDir, pointDir, pointFresnel
        );
        float pointCoatFresnel;
        vec3 pointCoat = pbrClearcoatLobe(
            u_clearcoat, u_clearcoatRoughness, n, viewDir, pointDir, pointCoatFresnel
        );
        lit += (pointBrdf * (1.0 - pointCoatFresnel * u_clearcoat) + pointCoat)
            * u_pointColors[index] * u_pointIntensities[index]
            * nDotPoint * attenuation;
    }
    lit += emission;
    float fogD = distance(v_worldPos, u_camEye);
    float fogF = clamp((fogD - u_fogNear) / max(1.0, u_fogFar - u_fogNear), 0.0, 1.0);
    vec3 surface = mix(lit, u_fogColor, fogF);
    if (u_transparentPass == 1 && u_transmission > 0.0) {
        float eta = 1.0 / max(u_ior, 1.0);
        vec2 refractedUv = clamp(screenUv + n.xy * (1.0 - eta) * 0.005, vec2(0.001), vec2(0.999));
        vec3 transmitted = texture(u_sceneCopy, refractedUv).rgb;
        surface = mix(surface, transmitted, clamp(u_transmission, 0.0, 1.0));
    }
    frag = vec4(surface, base.a);
}

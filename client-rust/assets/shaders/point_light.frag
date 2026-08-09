// Deferred point light: reconstruct world position from depth at this fragment,
// decode the G-buffer, and add a Cook-Torrance point-light term with smooth
// radius falloff. Additive into the HDR scene target; discard outside radius.
in vec4 v_posRadius;
in vec4 v_colorIntensity;

uniform sampler2D u_gb0;
uniform sampler2D u_gb1;
uniform sampler2D u_gb3;
uniform sampler2D u_depth;
uniform mat4 u_invViewProj;
uniform vec3 u_camEye;
uniform vec2 u_screenSize;
uniform float u_exposure;

out vec4 frag;


vec3 decodeOctahedral(vec2 encoded) {
    vec2 f = encoded * 2.0 - 1.0;
    vec3 normal = vec3(f, 1.0 - abs(f.x) - abs(f.y));
    float fold = clamp(-normal.z, 0.0, 1.0);
    normal.xy += vec2(normal.x >= 0.0 ? -fold : fold, normal.y >= 0.0 ? -fold : fold);
    return normalize(normal);
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_screenSize;
    float depth = texture(u_depth, uv).r;
    if (depth >= 1.0) { discard; }
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 wp = u_invViewProj * clip;
    vec3 P = wp.xyz / wp.w;

    vec3 lightPos = v_posRadius.xyz;
    float radius = v_posRadius.w;
    vec3 d = lightPos - P;
    float dist = length(d);
    if (dist > radius) { discard; }

    vec4 g0 = texture(u_gb0, uv);
    vec4 g1 = texture(u_gb1, uv);
    vec4 g3 = texture(u_gb3, uv);
    vec3 albedo = g0.rgb;
    float metallic = g0.a;
    vec3 N = decodeOctahedral(g1.rg);
    float roughness = clamp(g1.b, 0.045, 1.0);
    float clearcoat = g3.r;
    float clearcoatRoughness = clamp(g3.g, 0.045, 1.0);
    float dielectricF0 = g3.b;

    vec3 L = d / max(dist, 1e-4);
    vec3 V = normalize(u_camEye - P);
    float NdotL = max(dot(N, L), 0.0);
    vec3 fresnelValue;
    vec3 baseLobe = pbrBaseLobe(
        albedo,
        metallic,
        roughness,
        dielectricF0,
        N,
        V,
        L,
        fresnelValue
    );
    float clearcoatFresnel;
    vec3 clearcoatLobe = pbrClearcoatLobe(
        clearcoat,
        clearcoatRoughness,
        N,
        V,
        L,
        clearcoatFresnel
    );

    float x = clamp(1.0 - pow(dist / radius, 4.0), 0.0, 1.0);
    float atten = (x * x) / (dist * dist + 1.0);
    vec3 radiance = v_colorIntensity.rgb * v_colorIntensity.w * atten;
    vec3 color = (
        baseLobe * (1.0 - clearcoat * clearcoatFresnel)
        + clearcoatLobe
    ) * radiance * NdotL;
    frag = vec4(color * u_exposure, 1.0);
}

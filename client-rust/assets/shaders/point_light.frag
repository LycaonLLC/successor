// Deferred point light: reconstruct world position from depth at this fragment,
// decode the G-buffer, and add a Cook-Torrance point-light term with smooth
// radius falloff. Additive into the HDR scene target; discard outside radius.
in vec4 v_posRadius;
in vec4 v_colorIntensity;

uniform sampler2D u_gb0;
uniform sampler2D u_gb1;
uniform sampler2D u_depth;
uniform mat4 u_invViewProj;
uniform vec3 u_camEye;
uniform vec2 u_screenSize;
uniform float u_exposure;

out vec4 frag;

const float PI = 3.14159265359;

float distGGX(float NdotH, float rough) {
    float a = rough * rough;
    float a2 = a * a;
    float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
    return a2 / max(PI * d * d, 1e-5);
}
float geomSchlick(float NdotV, float rough) {
    float k = (rough + 1.0);
    k = k * k / 8.0;
    return NdotV / (NdotV * (1.0 - k) + k);
}
vec3 fresnel(float ct, vec3 f0) {
    return f0 + (1.0 - f0) * pow(clamp(1.0 - ct, 0.0, 1.0), 5.0);
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
    vec3 albedo = g0.rgb;
    float metallic = g0.a;
    vec3 N = normalize(g1.xyz * 2.0 - 1.0);
    float roughness = clamp(g1.a, 0.045, 1.0);

    vec3 L = d / max(dist, 1e-4);
    vec3 V = normalize(u_camEye - P);
    vec3 H = normalize(V + L);
    float NdotL = max(dot(N, L), 0.0);
    float NdotV = max(dot(N, V), 1e-4);
    float NdotH = max(dot(N, H), 0.0);
    float VdotH = max(dot(V, H), 0.0);

    vec3 F0 = mix(vec3(0.04), albedo, metallic);
    float D = distGGX(NdotH, roughness);
    float G = geomSchlick(NdotV, roughness) * geomSchlick(NdotL, roughness);
    vec3 F = fresnel(VdotH, F0);
    vec3 spec = (D * G) * F / max(4.0 * NdotV * NdotL, 1e-4);
    vec3 kd = (vec3(1.0) - F) * (1.0 - metallic);
    vec3 diff = kd * albedo / PI;

    float x = clamp(1.0 - pow(dist / radius, 4.0), 0.0, 1.0);
    float atten = (x * x) / (dist * dist + 1.0);
    vec3 radiance = v_colorIntensity.rgb * v_colorIntensity.w * atten;
    vec3 color = (diff + spec) * radiance * NdotL;
    frag = vec4(color * u_exposure, 1.0);
}

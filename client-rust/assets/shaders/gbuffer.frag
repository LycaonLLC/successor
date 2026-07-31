// glTF material G-buffer: base/metal, normal/roughness/AO, RGBM emission, clearcoat/F0.
in vec3 v_normal;
in vec2 v_uv;
in vec3 v_worldPos;
in vec4 v_color;
in vec4 v_tangent;

uniform vec4 u_color;
uniform sampler2D u_albedo;
uniform sampler2D u_mrTex;
uniform sampler2D u_normalTex;
uniform sampler2D u_aoTex;
uniform sampler2D u_emissiveTex;
uniform int u_hasTex;
uniform int u_hasMrTex;
uniform int u_hasNormalTex;
uniform int u_hasAoTex;
uniform int u_hasTangent;
uniform int u_hasEmissiveTex;
uniform float u_metallic;
uniform float u_roughness;
uniform float u_normalScale;
uniform float u_aoStrength;
uniform vec3 u_emissiveFactor;
uniform float u_emissiveStrength;
uniform float u_clearcoat;
uniform float u_clearcoatRoughness;
uniform float u_dielectricF0;
uniform float u_alphaCutoff;

layout(location = 0) out vec4 gb0;
layout(location = 1) out vec4 gb1;
layout(location = 2) out vec4 gb2;
layout(location = 3) out vec4 gb3;

vec4 encodeRgbm(vec3 color) {
    vec3 scaled = color / 32.0;
    float m = clamp(max(max(scaled.r, scaled.g), scaled.b), 1.0 / 255.0, 1.0);
    m = ceil(m * 255.0) / 255.0;
    return vec4(scaled / m, m);
}

vec2 encodeOctahedral(vec3 normal) {
    normal /= abs(normal.x) + abs(normal.y) + abs(normal.z);
    vec2 encoded = normal.xy;
    if (normal.z < 0.0) {
        encoded = (1.0 - abs(encoded.yx)) * sign(encoded.xy);
    }
    return encoded * 0.5 + 0.5;
}

vec3 mappedNormal(vec3 geometric, float faceSign) {
    vec3 n = normalize(geometric);
    if (u_hasNormalTex == 0) return n;
    vec3 map = texture(u_normalTex, v_uv).xyz * 2.0 - 1.0;
    map.xy *= u_normalScale;
    map = normalize(map);
    vec3 tangent;
    vec3 bitangent;
    if (u_hasTangent == 1) {
        tangent = normalize(v_tangent.xyz * faceSign - n * dot(n, v_tangent.xyz * faceSign));
        bitangent = normalize(cross(n, tangent)) * v_tangent.w;
    } else {
        vec3 dp1 = dFdx(v_worldPos);
        vec3 dp2 = dFdy(v_worldPos);
        vec2 duv1 = dFdx(v_uv);
        vec2 duv2 = dFdy(v_uv);
        tangent = normalize(dp1 * duv2.y - dp2 * duv1.y);
        tangent = normalize(tangent - n * dot(n, tangent));
        bitangent = normalize(cross(n, tangent));
    }
    return normalize(mat3(tangent, bitangent, n) * map);
}

void main() {
    vec4 base = u_color * v_color;
    if (u_hasTex == 1) base *= texture(u_albedo, v_uv);
    if (base.a < u_alphaCutoff) discard;
    vec4 mr = u_hasMrTex == 1 ? texture(u_mrTex, v_uv) : vec4(1.0);
    float metallic = clamp(u_metallic * mr.b, 0.0, 1.0);
    float roughness = clamp(u_roughness * mr.g, 0.045, 1.0);
    float aoSample = u_hasAoTex == 1 ? texture(u_aoTex, v_uv).r : 1.0;
    float ao = 1.0 + u_aoStrength * (aoSample - 1.0);
    vec3 emission = u_emissiveFactor * u_emissiveStrength;
    if (u_hasEmissiveTex == 1) emission *= texture(u_emissiveTex, v_uv).rgb;
    float faceSign = gl_FrontFacing ? 1.0 : -1.0;
    vec3 normal = mappedNormal(v_normal * faceSign, faceSign);
    gb0 = vec4(base.rgb, metallic);
    gb1 = vec4(encodeOctahedral(normal), roughness, ao);
    gb2 = encodeRgbm(emission);
    gb3 = vec4(u_clearcoat, u_clearcoatRoughness, u_dielectricF0, 0.0);
}

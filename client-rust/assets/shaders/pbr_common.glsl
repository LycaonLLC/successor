// Shared glTF metallic-roughness and clearcoat BRDF helpers.
const float PBR_PI = 3.14159265359;

float pbrDistributionGgx(float nDotH, float roughness) {
    float alpha = roughness * roughness;
    float alpha2 = alpha * alpha;
    float denominator = nDotH * nDotH * (alpha2 - 1.0) + 1.0;
    return alpha2 / max(PBR_PI * denominator * denominator, 1e-5);
}

float pbrGeometrySchlick(float nDotV, float roughness) {
    float k = roughness + 1.0;
    k = k * k / 8.0;
    return nDotV / max(nDotV * (1.0 - k) + k, 1e-5);
}

vec3 pbrFresnelSchlick(float cosine, vec3 f0) {
    return f0 + (1.0 - f0) * pow(clamp(1.0 - cosine, 0.0, 1.0), 5.0);
}

vec3 pbrBaseLobe(
    vec3 baseColor,
    float metallic,
    float perceptualRoughness,
    float dielectricF0,
    vec3 normal,
    vec3 viewDir,
    vec3 lightDir,
    out vec3 fresnelValue
) {
    vec3 halfDir = normalize(viewDir + lightDir);
    float nDotL = max(dot(normal, lightDir), 0.0);
    float nDotV = max(dot(normal, viewDir), 1e-4);
    float nDotH = max(dot(normal, halfDir), 0.0);
    float vDotH = max(dot(viewDir, halfDir), 0.0);
    vec3 f0 = mix(vec3(dielectricF0), baseColor, metallic);
    float distribution = pbrDistributionGgx(nDotH, perceptualRoughness);
    float geometry = pbrGeometrySchlick(nDotV, perceptualRoughness)
        * pbrGeometrySchlick(nDotL, perceptualRoughness);
    fresnelValue = pbrFresnelSchlick(vDotH, f0);
    vec3 specular = distribution * geometry * fresnelValue
        / max(4.0 * nDotV * nDotL, 1e-4);
    vec3 diffuse = (vec3(1.0) - fresnelValue) * (1.0 - metallic)
        * baseColor / PBR_PI;
    return diffuse + specular;
}

vec3 pbrClearcoatLobe(
    float clearcoat,
    float clearcoatRoughness,
    vec3 normal,
    vec3 viewDir,
    vec3 lightDir,
    out float clearcoatFresnel
) {
    vec3 halfDir = normalize(viewDir + lightDir);
    float nDotL = max(dot(normal, lightDir), 0.0);
    float nDotV = max(dot(normal, viewDir), 1e-4);
    float nDotH = max(dot(normal, halfDir), 0.0);
    float vDotH = max(dot(viewDir, halfDir), 0.0);
    float distribution = pbrDistributionGgx(nDotH, clearcoatRoughness);
    float geometry = pbrGeometrySchlick(nDotV, clearcoatRoughness)
        * pbrGeometrySchlick(nDotL, clearcoatRoughness);
    clearcoatFresnel = pbrFresnelSchlick(vDotH, vec3(0.04)).r;
    return vec3(clearcoat * distribution * geometry * clearcoatFresnel
        / max(4.0 * nDotV * nDotL, 1e-4));
}

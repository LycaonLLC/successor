// HDR resolve, environment grade, mastering grade, optional palette
// quantization, and opaque-depth restoration.
in vec2 v_uv;
uniform sampler2D u_scene;
uniform sampler2D u_depth;
uniform sampler2D u_bloomTex;
uniform vec3 u_boneTint;
uniform float u_desaturate;
uniform float u_sceneDarken;
uniform float u_blackLift;
uniform float u_bloomIntensity;
uniform float u_invExposure;
uniform float u_masterExposure;
uniform float u_saturation;
uniform float u_contrast;
uniform float u_gamma;
uniform float u_temperature;
uniform float u_tint;
uniform vec3 u_lift;
uniform vec3 u_colorGamma;
uniform vec3 u_gain;
uniform int u_paletteEnabled;
uniform float u_paletteLevels;
uniform float u_paletteStrength;
uniform float u_paletteDither;
out vec4 frag;

vec3 aces(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

float bayer4(vec2 pixel) {
    ivec2 p = ivec2(mod(pixel, 4.0));
    int index = p.x + p.y * 4;
    const float values[16] = float[16](
         0.0,  8.0,  2.0, 10.0,
        12.0,  4.0, 14.0,  6.0,
         3.0, 11.0,  1.0,  9.0,
        15.0,  7.0, 13.0,  5.0
    );
    return values[index] / 16.0 - 0.5;
}

void main() {
    vec3 hdr = texture(u_scene, v_uv).rgb * u_invExposure;
    hdr += texture(u_bloomTex, v_uv).rgb * u_invExposure * u_bloomIntensity;
    vec3 c = aces(hdr * u_masterExposure);

    // Authored environment grade.
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(c, vec3(l), clamp(u_desaturate, 0.0, 1.0));
    c *= u_boneTint;
    c *= u_sceneDarken;
    c = c + u_blackLift * (1.0 - c);

    // Mastering controls: white balance, lift/gamma/gain, saturation,
    // contrast, then display gamma.
    vec3 balance = vec3(
        1.0 + u_temperature * 0.12 - u_tint * 0.03,
        1.0 + u_tint * 0.08,
        1.0 - u_temperature * 0.12 - u_tint * 0.03
    );
    c *= max(balance, vec3(0.01));
    c = max(c + u_lift, vec3(0.0));
    c = pow(c, vec3(1.0) / max(u_colorGamma, vec3(0.01))) * u_gain;
    l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, u_saturation);
    c = (c - 0.5) * u_contrast + 0.5;
    c = pow(max(c, vec3(0.0)), vec3(1.0 / max(u_gamma, 0.01)));
    c = clamp(c, 0.0, 1.0);

    if (u_paletteEnabled != 0) {
        float steps = max(u_paletteLevels - 1.0, 1.0);
        float noise = bayer4(gl_FragCoord.xy) * u_paletteDither;
        vec3 quantized = floor(c * steps + 0.5 + noise) / steps;
        c = mix(c, clamp(quantized, 0.0, 1.0), u_paletteStrength);
    }

    frag = vec4(c, 1.0);
    gl_FragDepth = texture(u_depth, v_uv).r;
}

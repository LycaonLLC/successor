// FXAA 3.11 quality preset 12, post-tonemap spatial antialiasing.
in vec2 v_uv;
uniform sampler2D u_ldr;
uniform sampler2D u_depth;
uniform vec2 u_invResolution;
out vec4 frag;

float luma(vec3 rgb) { return dot(rgb, vec3(0.299, 0.587, 0.114)); }

void main() {
    vec3 rgbM = texture(u_ldr, v_uv).rgb;
    float lumaM = luma(rgbM);
    float lumaN = luma(texture(u_ldr, v_uv + vec2(0.0, u_invResolution.y)).rgb);
    float lumaS = luma(texture(u_ldr, v_uv - vec2(0.0, u_invResolution.y)).rgb);
    float lumaE = luma(texture(u_ldr, v_uv + vec2(u_invResolution.x, 0.0)).rgb);
    float lumaW = luma(texture(u_ldr, v_uv - vec2(u_invResolution.x, 0.0)).rgb);
    float rangeMin = min(lumaM, min(min(lumaN, lumaS), min(lumaE, lumaW)));
    float rangeMax = max(lumaM, max(max(lumaN, lumaS), max(lumaE, lumaW)));
    float range = rangeMax - rangeMin;
    if (range < max(0.0312, rangeMax * 0.125)) {
        frag = vec4(rgbM, 1.0);
        gl_FragDepth = texture(u_depth, v_uv).r;
        return;
    }
    float edgeH = abs(lumaN + lumaS - 2.0 * lumaM);
    float edgeV = abs(lumaE + lumaW - 2.0 * lumaM);
    vec2 direction = edgeH >= edgeV ? vec2(u_invResolution.x, 0.0) : vec2(0.0, u_invResolution.y);
    float gradientA = abs((edgeH >= edgeV ? lumaW : lumaS) - lumaM);
    float gradientB = abs((edgeH >= edgeV ? lumaE : lumaN) - lumaM);
    if (gradientA > gradientB) direction = -direction;
    const float STEPS[5] = float[5](1.0, 1.5, 2.0, 4.0, 12.0);
    vec2 uvA = v_uv;
    vec2 uvB = v_uv;
    float edgeLuma = 0.5 * (lumaM + (gradientA > gradientB ? (edgeH >= edgeV ? lumaW : lumaS) : (edgeH >= edgeV ? lumaE : lumaN)));
    float endA = lumaM;
    float endB = lumaM;
    for (int i = 0; i < 5; i++) {
        uvA -= direction * STEPS[i];
        uvB += direction * STEPS[i];
        endA = luma(texture(u_ldr, uvA).rgb) - edgeLuma;
        endB = luma(texture(u_ldr, uvB).rgb) - edgeLuma;
        if (abs(endA) >= range * 0.25 && abs(endB) >= range * 0.25) break;
    }
    float distanceA = length(v_uv - uvA);
    float distanceB = length(uvB - v_uv);
    float span = max(distanceA + distanceB, 1e-5);
    float offset = 0.5 - min(distanceA, distanceB) / span;
    vec2 normal = edgeH >= edgeV ? vec2(0.0, u_invResolution.y) : vec2(u_invResolution.x, 0.0);
    vec3 aa = texture(u_ldr, v_uv + normal * offset).rgb;
    float subpixel = clamp((lumaN + lumaS + lumaE + lumaW) * 0.25 - lumaM, -range, range);
    float blend = clamp(abs(subpixel) / max(range, 1e-5), 0.0, 1.0);
    frag = vec4(mix(aa, (rgbM + aa) * 0.5, blend * 0.75), 1.0);
    gl_FragDepth = texture(u_depth, v_uv).r;
}

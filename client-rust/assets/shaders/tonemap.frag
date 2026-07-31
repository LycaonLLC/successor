// Tonemap + PS2 color grade, resolving the HDR scene target to the screen and
// restoring scene depth (so particles depth-test correctly afterward). ACES
// fitted tonemap, then the environment grade (port of post.frag). `u_invExposure`
// undoes the RGBA8-prescale exposure applied in the light pass (1.0 for 16F).
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
out vec4 frag;

vec3 aces(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
    vec3 hdr = texture(u_scene, v_uv).rgb * u_invExposure;
    hdr += texture(u_bloomTex, v_uv).rgb * u_invExposure * u_bloomIntensity;
    vec3 c = aces(hdr);
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(c, vec3(l), clamp(u_desaturate, 0.0, 1.0));
    c *= u_boneTint;
    c *= u_sceneDarken;
    c = c + u_blackLift * (1.0 - c);
    frag = vec4(clamp(c, 0.0, 1.0), 1.0);
    gl_FragDepth = texture(u_depth, v_uv).r;
}

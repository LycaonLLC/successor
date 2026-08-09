// PS2-era color grade over the rendered scene (port of the environment grade):
// desaturate → bone tint → scene darken (exposure) → black lift, with an
// ordered-dither to fake extra bit-depth. Bloom is approximated by lifting the
// brightest highlights slightly (cheap, no separable blur pass).
in vec2 v_uv;
uniform sampler2D u_scene;
uniform vec3 u_boneTint;
uniform float u_desaturate;
uniform float u_sceneDarken;
uniform float u_blackLift;
uniform float u_bloom;
out vec4 frag;

void main() {
    vec3 c = texture(u_scene, v_uv).rgb;
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(c, vec3(l), clamp(u_desaturate, 0.0, 1.0));
    c *= u_boneTint;
    c *= u_sceneDarken;
    c = c + u_blackLift * (1.0 - c);
    // Cheap highlight bloom: add a fraction of the supra-threshold luminance.
    float hi = max(l - 0.72, 0.0);
    c += hi * u_bloom * u_boneTint;
    frag = vec4(clamp(c, 0.0, 1.0), 1.0);
}

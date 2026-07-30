// Glow-sprite sampled billboard, modulated by the per-vertex color (rgb + a).
in vec2 v_uv;
in vec4 v_col;
uniform sampler2D u_tex;
out vec4 frag;
void main() {
    vec4 t = texture(u_tex, v_uv);
    frag = vec4(v_col.rgb * t.rgb, v_col.a * t.a);
    if (frag.a <= 0.003) discard;
}

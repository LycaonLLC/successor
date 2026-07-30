// Solid quads (uv.x < 0) draw the vertex color directly. Otherwise sample the
// icon atlas coverage (stored in .a) and modulate the vertex color's alpha.
in vec2 v_uv;
in vec4 v_col;
uniform sampler2D u_atlas;
out vec4 frag;
void main() {
    if (v_uv.x < 0.0) {
        frag = v_col;
    } else {
        float cov = texture(u_atlas, v_uv).a;
        frag = vec4(v_col.rgb, v_col.a * cov);
    }
}

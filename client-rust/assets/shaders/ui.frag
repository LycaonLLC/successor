// Solid quads (uv.x < 0) draw the vertex color directly. Coverage masks use
// atlas UVs in [0,1]. Full-color images encode U in [2,3] and are decoded here.
in vec2 v_uv;
in vec4 v_col;
uniform sampler2D u_atlas;
out vec4 frag;
void main() {
    if (v_uv.x < 0.0) {
        frag = v_col;
    } else if (v_uv.x > 1.0) {
        frag = texture(u_atlas, vec2(v_uv.x - 2.0, v_uv.y)) * v_col;
    } else {
        float cov = texture(u_atlas, v_uv).a;
        frag = vec4(v_col.rgb, v_col.a * cov);
    }
}

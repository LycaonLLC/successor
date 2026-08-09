// World-space particle billboards (PARTICLE_LAYOUT): pos3, uv2, color4.
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec4 a_col;
uniform mat4 u_viewProj;
out vec2 v_uv;
out vec4 v_col;
void main() {
    v_uv = a_uv;
    v_col = a_col;
    gl_Position = u_viewProj * vec4(a_pos, 1.0);
}

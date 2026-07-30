// Mesh vertex shader. The GL backend prepends the target header
// (`#version 330 core` on desktop, `#version 300 es` + precision on web).
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;

uniform mat4 u_model;
uniform mat4 u_viewProj;
uniform mat4 u_lightViewProj;

out vec3 v_normal;
out vec4 v_lightPos;

void main() {
    vec4 world = u_model * vec4(a_pos, 1.0);
    gl_Position = u_viewProj * world;
    v_normal = mat3(u_model) * a_normal;
    v_lightPos = u_lightViewProj * world;
}

// Shadow depth pass: transform into light clip space only.
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;

uniform mat4 u_model;
uniform mat4 u_lightViewProj;

void main() {
    gl_Position = u_lightViewProj * u_model * vec4(a_pos, 1.0);
}

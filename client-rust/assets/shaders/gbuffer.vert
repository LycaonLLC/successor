// Deferred G-buffer vertex shader. The GL backend prepends the target header
// (`#version 330 core` / `#version 300 es` + precision); the renderer prepends
// `#define SKINNED 1` for the skinned variant.
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;
#ifdef SKINNED
layout(location = 3) in vec4 a_joints;
layout(location = 4) in vec4 a_weights;
uniform mat4 u_joints[64];
#endif

uniform mat4 u_model;
uniform mat4 u_viewProj;

out vec3 v_normal;
out vec2 v_uv;
out vec3 v_worldPos;

void main() {
#ifdef SKINNED
    mat4 skin =
        a_weights.x * u_joints[int(a_joints.x)] +
        a_weights.y * u_joints[int(a_joints.y)] +
        a_weights.z * u_joints[int(a_joints.z)] +
        a_weights.w * u_joints[int(a_joints.w)];
    vec4 local = skin * vec4(a_pos, 1.0);
    vec3 nrm = mat3(skin) * a_normal;
#else
    vec4 local = vec4(a_pos, 1.0);
    vec3 nrm = a_normal;
#endif
    vec4 world = u_model * local;
    gl_Position = u_viewProj * world;
    v_normal = mat3(u_model) * nrm;
    v_uv = a_uv;
    v_worldPos = world.xyz;
}

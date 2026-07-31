// Deferred G-buffer vertex shader. The GL backend prepends the target header
// (`#version 330 core` / `#version 300 es` + precision); the renderer prepends
// `#define SKINNED 1` for the skinned variant.
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;
layout(location = 3) in vec4 a_tangent;
layout(location = 4) in vec4 a_color;
uniform int u_hasVertexColor;
uniform int u_hasTangent;
#ifdef SKINNED
layout(location = 5) in vec4 a_joints;
layout(location = 6) in vec4 a_weights;
uniform mat4 u_joints[64];
#endif

uniform mat4 u_model;
uniform mat4 u_viewProj;

out vec3 v_normal;
out vec2 v_uv;
out vec3 v_worldPos;
out vec4 v_color;
out vec4 v_tangent;

void main() {
    mat4 deform = u_model;
#ifdef SKINNED
    mat4 skin =
        a_weights.x * u_joints[int(a_joints.x)] +
        a_weights.y * u_joints[int(a_joints.y)] +
        a_weights.z * u_joints[int(a_joints.z)] +
        a_weights.w * u_joints[int(a_joints.w)];
    deform = u_model * skin;
#endif
    vec4 world = deform * vec4(a_pos, 1.0);
    gl_Position = u_viewProj * world;
    mat3 normalMatrix = transpose(inverse(mat3(deform)));
    v_normal = normalMatrix * a_normal;
    v_uv = a_uv;
    v_color = u_hasVertexColor == 1 ? a_color : vec4(1.0);
    vec3 tangent = u_hasTangent == 1
        ? normalize(mat3(deform) * a_tangent.xyz)
        : vec3(1.0, 0.0, 0.0);
    v_tangent = vec4(tangent, u_hasTangent == 1 ? a_tangent.w : 1.0);
    v_worldPos = world.xyz;
}

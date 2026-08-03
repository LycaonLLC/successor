// Skinned mesh vertex shader. Same outputs as mesh.vert (pairs with mesh.frag);
// applies a linear-blend-skinning palette before the model transform. The GL
// backend prepends the target header (#version 330 core / 300 es + precision).
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;
layout(location = 5) in vec4 a_joints;
layout(location = 6) in vec4 a_weights;

uniform mat4 u_model;
uniform mat4 u_viewProj;
uniform mat4 u_lightViewProj;
uniform mat4 u_joints[50];
out vec3 v_normal;
out vec4 v_lightPos;
out vec2 v_uv;
out vec3 v_worldPos;

void main() {
    mat4 skin =
        a_weights.x * u_joints[int(a_joints.x)] +
        a_weights.y * u_joints[int(a_joints.y)] +
        a_weights.z * u_joints[int(a_joints.z)] +
        a_weights.w * u_joints[int(a_joints.w)];
    vec4 skinned = skin * vec4(a_pos, 1.0);
    vec4 world = u_model * skinned;
    gl_Position = u_viewProj * world;
    v_normal = mat3(u_model) * mat3(skin) * a_normal;
    v_lightPos = u_lightViewProj * world;
    v_uv = a_uv;
    v_worldPos = world.xyz;
}

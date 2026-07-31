// Shadow depth pass. The renderer prepends SKINNED or INSTANCED.
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;
#ifdef SKINNED
layout(location = 5) in vec4 a_joints;
layout(location = 6) in vec4 a_weights;
uniform mat4 u_joints[64];
#endif
#ifdef INSTANCED
layout(location = 7) in vec4 a_instance0;
layout(location = 8) in vec4 a_instance1;
layout(location = 9) in vec4 a_instance2;
layout(location = 10) in vec4 a_instance3;
#endif

uniform mat4 u_model;
uniform mat4 u_lightViewProj;

void main() {
#ifdef SKINNED
    mat4 skin =
        a_weights.x * u_joints[int(a_joints.x)] +
        a_weights.y * u_joints[int(a_joints.y)] +
        a_weights.z * u_joints[int(a_joints.z)] +
        a_weights.w * u_joints[int(a_joints.w)];
    vec4 local = skin * vec4(a_pos, 1.0);
#else
    vec4 local = vec4(a_pos, 1.0);
#endif
#ifdef INSTANCED
    mat4 instanceModel = mat4(a_instance0, a_instance1, a_instance2, a_instance3);
    gl_Position = u_lightViewProj * u_model * instanceModel * local;
#else
    gl_Position = u_lightViewProj * u_model * local;
#endif
}

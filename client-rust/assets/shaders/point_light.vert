// Point-light bounding volume (unit sphere), instanced. Instance attrs:
// a_posRadius = world center + radius, a_colorIntensity = linear rgb + intensity.
layout(location = 0) in vec3 a_pos;
layout(location = 5) in vec4 a_posRadius;
layout(location = 6) in vec4 a_colorIntensity;

uniform mat4 u_viewProj;

out vec4 v_posRadius;
out vec4 v_colorIntensity;

void main() {
    vec3 world = a_posRadius.xyz + a_pos * a_posRadius.w;
    gl_Position = u_viewProj * vec4(world, 1.0);
    v_posRadius = a_posRadius;
    v_colorIntensity = a_colorIntensity;
}

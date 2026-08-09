// Tessellated terrain G-buffer vertex path. Height is streamed in the alpha
// channel of the per-chunk control texture, encoded over [-4, 4] world units.
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;

uniform mat4 u_model;
uniform mat4 u_viewProj;
uniform sampler2D u_terrainControl;
uniform vec2 u_terrainOrigin;
uniform float u_terrainWorldSize;

out vec3 v_normal;
out vec2 v_uv;
out vec3 v_worldPos;
out vec4 v_color;
out vec4 v_tangent;

vec2 terrainControlUv(vec2 worldXZ) {
    vec2 chunkUv = clamp((worldXZ - u_terrainOrigin) / u_terrainWorldSize, vec2(0.0), vec2(1.0));
    return (chunkUv * 127.0 + 1.5) / 130.0;
}

void main() {
    vec4 world = u_model * vec4(a_pos, 1.0);
    float encodedHeight = texture(u_terrainControl, terrainControlUv(world.xz)).a;
    world.y += encodedHeight * 8.0 - 4.0;
    gl_Position = u_viewProj * world;
    v_normal = vec3(0.0, 1.0, 0.0);
    v_uv = a_uv;
    v_color = vec4(1.0);
    v_tangent = vec4(1.0, 0.0, 0.0, 1.0);
    v_worldPos = world.xyz;
}

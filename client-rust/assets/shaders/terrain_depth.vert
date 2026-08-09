// Shadow-depth counterpart of terrain_gbuffer.vert. Both paths decode the same
// streamed alpha height so terrain receives and casts shadows at one surface.
layout(location = 0) in vec3 a_pos;

uniform mat4 u_model;
uniform mat4 u_lightViewProj;
uniform sampler2D u_terrainControl;
uniform vec2 u_terrainOrigin;
uniform float u_terrainWorldSize;
out vec3 v_worldPos;

vec2 terrainControlUv(vec2 worldXZ) {
    vec2 chunkUv = clamp((worldXZ - u_terrainOrigin) / u_terrainWorldSize, vec2(0.0), vec2(1.0));
    return (chunkUv * 127.0 + 1.5) / 130.0;
}

void main() {
    vec4 world = u_model * vec4(a_pos, 1.0);
    float encodedHeight = texture(u_terrainControl, terrainControlUv(world.xz)).a;
    world.y += encodedHeight * 8.0 - 4.0;
    v_worldPos = world.xyz;
    gl_Position = u_lightViewProj * world;
}

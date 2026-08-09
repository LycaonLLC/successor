in vec2 v_uv;
uniform sampler2D u_scene;
uniform float u_threshold;
out vec4 frag;
void main() {
    vec3 scene = texture(u_scene, v_uv).rgb;
    frag = vec4(max(scene - vec3(u_threshold), vec3(0.0)), 1.0);
}

// Composite/RTT pass: sample a render target's color texture.
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 frag;
void main() {
    frag = texture(u_tex, v_uv);
}

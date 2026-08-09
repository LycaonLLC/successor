precision highp float;

in vec2 v_uv;
uniform sampler2D u_source;
out vec4 out_color;

void main() {
    out_color = texture(u_source, v_uv);
}

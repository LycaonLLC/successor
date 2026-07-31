in vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_direction;
out vec4 frag;
void main() {
    vec3 color = texture(u_source, v_uv).rgb * 0.2270270270;
    color += texture(u_source, v_uv + u_direction * 1.3846153846).rgb * 0.3162162162;
    color += texture(u_source, v_uv - u_direction * 1.3846153846).rgb * 0.3162162162;
    color += texture(u_source, v_uv + u_direction * 3.2307692308).rgb * 0.0702702703;
    color += texture(u_source, v_uv - u_direction * 3.2307692308).rgb * 0.0702702703;
    frag = vec4(color, 1.0);
}

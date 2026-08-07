// Shadow depth pass: height-cut geometry must not retain an opaque shadow.
in vec3 v_worldPos;
uniform vec2 u_cutaway;
void main() {
    if (v_worldPos.y > u_cutaway.x && u_cutaway.y > 0.0) {
        float dither = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
        if (dither < u_cutaway.y) discard;
    }
}

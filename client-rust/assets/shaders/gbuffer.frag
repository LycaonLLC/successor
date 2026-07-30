// Deferred G-buffer fragment shader. Packs albedo+metallic (GB0) and
// world-normal+roughness (GB1). Screen-door (Bayer 4x4) dithered transparency
// via discard keeps the G-buffer opaque and order-independent.
in vec3 v_normal;
in vec2 v_uv;
in vec3 v_worldPos;

uniform vec4 u_color;      // rgb + alpha (alpha < 1 => dithered)
uniform sampler2D u_albedo;
uniform int u_hasTex;
uniform float u_metallic;
uniform float u_roughness;

layout(location = 0) out vec4 gb0; // albedo.rgb, metallic
layout(location = 1) out vec4 gb1; // normal*0.5+0.5, roughness

float bayer4(vec2 p) {
    int x = int(mod(p.x, 4.0));
    int y = int(mod(p.y, 4.0));
    int i = x + y * 4;
    float m[16];
    m[0]=0.0;  m[1]=8.0;  m[2]=2.0;  m[3]=10.0;
    m[4]=12.0; m[5]=4.0;  m[6]=14.0; m[7]=6.0;
    m[8]=3.0;  m[9]=11.0; m[10]=1.0; m[11]=9.0;
    m[12]=15.0;m[13]=7.0; m[14]=13.0;m[15]=5.0;
    return (m[i] + 0.5) / 16.0;
}

void main() {
    vec4 base = (u_hasTex == 1) ? texture(u_albedo, v_uv) : u_color;
    if (base.a < 0.999) {
        if (base.a < bayer4(gl_FragCoord.xy)) discard;
    }
    vec3 n = normalize(v_normal);
    gb0 = vec4(base.rgb, u_metallic);
    gb1 = vec4(n * 0.5 + 0.5, u_roughness);
}

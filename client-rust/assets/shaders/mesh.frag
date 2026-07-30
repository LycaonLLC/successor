// Mesh fragment shader: single directional light + ambient, 3x3 PCF shadow,
// and screen-door (Bayer 4x4) dithered transparency — no blending, order
// independent.
in vec3 v_normal;
in vec4 v_lightPos;
in vec2 v_uv;
in vec3 v_worldPos;

uniform vec3 u_lightDir;
uniform vec3 u_lightColor;
uniform vec4 u_color;      // rgb + alpha (alpha < 1 => dithered)
uniform float u_ambient;
uniform sampler2D u_shadowMap;
uniform int u_useShadow;
uniform sampler2D u_albedo;
uniform int u_hasTex;
uniform vec3 u_camEye;
uniform vec3 u_fogColor;
uniform float u_fogNear;
uniform float u_fogFar;

out vec4 frag;

float bayer4(vec2 p) {
    int x = int(mod(p.x, 4.0));
    int y = int(mod(p.y, 4.0));
    int i = x + y * 4;
    // Normalized 4x4 Bayer threshold matrix (values 0..15)/16.
    float m[16];
    m[0]=0.0;  m[1]=8.0;  m[2]=2.0;  m[3]=10.0;
    m[4]=12.0; m[5]=4.0;  m[6]=14.0; m[7]=6.0;
    m[8]=3.0;  m[9]=11.0; m[10]=1.0; m[11]=9.0;
    m[12]=15.0;m[13]=7.0; m[14]=13.0;m[15]=5.0;
    return (m[i] + 0.5) / 16.0;
}

float shadowFactor(vec4 lp) {
    vec3 proj = lp.xyz / lp.w;
    proj = proj * 0.5 + 0.5;
    if (proj.z > 1.0) return 1.0;
    float bias = 0.0025;
    vec2 texel = vec2(1.0 / 2048.0);
    float sum = 0.0;
    for (int x = -1; x <= 1; x++) {
        for (int y = -1; y <= 1; y++) {
            float d = texture(u_shadowMap, proj.xy + vec2(float(x), float(y)) * texel).r;
            sum += (proj.z - bias > d) ? 0.0 : 1.0;
        }
    }
    return sum / 9.0;
}

void main() {
    vec3 n = normalize(v_normal);
    float ndl = max(dot(n, normalize(-u_lightDir)), 0.0);
    float sh = (u_useShadow == 1) ? shadowFactor(v_lightPos) : 1.0;
    vec4 base = (u_hasTex == 1) ? texture(u_albedo, v_uv) : u_color;
    vec3 lit = base.rgb * (u_ambient + ndl * sh) * u_lightColor;

    if (base.a < 0.999) {
        if (base.a < bayer4(gl_FragCoord.xy)) discard;
    }
    float fogD = distance(v_worldPos, u_camEye);
    float fogF = clamp((fogD - u_fogNear) / max(1.0, u_fogFar - u_fogNear), 0.0, 1.0);
    frag = vec4(mix(lit, u_fogColor, fogF), 1.0);
}

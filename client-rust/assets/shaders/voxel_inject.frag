// VXGI radiance injection: one layer (Z slice) of the radiance volume. Each
// fragment is a voxel; sample the albedo volume's occupancy, compute sun
// visibility from the shadow map at the voxel's world center, and output
// radiance (rgb) + occupancy (a). Pairs with post.vert; drawn over a 64x64
// framebuffer layer.
in vec2 v_uv;

uniform sampler3D u_albedoVol;
uniform sampler2D u_shadowMap;
uniform float u_layer;
uniform vec3 u_giOrigin;
uniform float u_giCell;
uniform mat4 u_lightViewProj;
uniform vec3 u_lightDir;
uniform vec3 u_lightColor;

out vec4 frag;

const float GI_SIZE = 64.0;
const float NDOTL_PROXY = 0.75; // isotropic voxels carry no normal.

void main() {
    vec3 vi = vec3(floor(gl_FragCoord.x), floor(gl_FragCoord.y), u_layer);
    vec3 uvw = (vi + 0.5) / GI_SIZE;
    vec4 a = texture(u_albedoVol, uvw);
    if (a.a < 0.5) {
        frag = vec4(0.0);
        return;
    }
    vec3 center = u_giOrigin + (vi + 0.5) * u_giCell;
    // Sun visibility (single tap).
    vec4 lp = u_lightViewProj * vec4(center, 1.0);
    vec3 proj = lp.xyz / lp.w * 0.5 + 0.5;
    float vis = 1.0;
    if (proj.x >= 0.0 && proj.x <= 1.0 && proj.y >= 0.0 && proj.y <= 1.0 && proj.z <= 1.0) {
        float d = texture(u_shadowMap, proj.xy).r;
        vis = (proj.z - 0.004 > d) ? 0.0 : 1.0;
    }
    frag = vec4(a.rgb * u_lightColor * vis * NDOTL_PROXY, a.a);
}

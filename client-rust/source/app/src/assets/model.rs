//! Shared GLB upload and bounded embedded point-light extraction.
//!
//! Explicit `KHR_lights_punctual` point lights are authoritative. Checked-in
//! models that do not carry the extension can still produce local lighting from
//! semantically named emissive geometry. All inference happens once while the
//! asset is loaded; world instances reuse the resulting descriptors.

use std::collections::BTreeMap;

use successor_engine_core::glb::{self, GlbDocument, GlbLightKind, GlbPrimitive};
use successor_engine_core::math::{vec3, Mat4, Vec3};
use successor_engine_render::components::{MaterialId, MeshId};
use successor_engine_render::gpu::Gpu;
use successor_engine_render::renderer::Renderer;

pub const MAX_LIGHTS_PER_MODEL: usize = 64;

const CELL_SIZE_METERS: f32 = 2.0;
const MERGE_DISTANCE_METERS: f32 = 0.25;
const MAX_NORMAL_OFFSET_METERS: f32 = 0.05;
const MIN_EMISSIVE_LIGHT_FLUX: f32 = 0.01;
const EMISSIVE_LIGHT_SCALE: f32 = 100.0;
const MIN_INFERRED_INTENSITY: f32 = 1.0;
const MAX_INFERRED_INTENSITY: f32 = 12.0;
const MIN_INFERRED_RADIUS_METERS: f32 = 1.5;
const MAX_INFERRED_RADIUS_METERS: f32 = 12.0;
const MAX_DERIVED_LIGHT_RADIUS_METERS: f32 = 32.0;
const DEFAULT_EXPLICIT_CUTOFF: f32 = 0.01;

const EMITTER_TOKENS: &[&str] = &[
    "glow",
    "lampglow",
    "sconce",
    "pendant",
    "chandelier",
    "beacon",
    "bulb",
    "flame",
    "ember",
    "campfire",
    "hearth",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmbeddedLightSource {
    Explicit,
    Inferred,
}

/// A point light anchored to one GLB node.
///
/// `local` is relative to `node`. Static models compose it with the node's rest
/// global transform; animated models compose it with the live skeleton global.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EmbeddedPointLight {
    pub source: EmbeddedLightSource,
    pub node: usize,
    pub local: Mat4,
    pub color: [f32; 3],
    pub intensity: f32,
    pub radius: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StaticPart {
    pub mesh: MeshId,
    pub material: MaterialId,
    pub local: Mat4,
}

#[derive(Clone, Debug, Default)]
pub struct StaticModel {
    pub parts: Vec<StaticPart>,
    pub lights: Vec<EmbeddedPointLight>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LightExtractionReport {
    /// Referenced explicit point lights retained by the importer.
    pub explicit: usize,
    /// Geometry clusters that passed emissive and semantic gates.
    pub candidates: usize,
    /// Combined explicit and inferred descriptors retained.
    pub retained: usize,
    /// Geometry clusters discarded below the global flux floor.
    pub suppressed_low_flux: usize,
    /// Inferred clusters suppressed by an authoritative explicit point light.
    pub suppressed_duplicate: usize,
    /// Combined explicit/inferred descriptors beyond the per-model budget.
    pub over_budget: usize,
    /// Invalid or over-budget model-light conditions. Runtime model load fails.
    pub errors: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct ClusterKey {
    anchor: usize,
    material: usize,
    component: usize,
    cell_x: i32,
    cell_y: i32,
    cell_z: i32,
}

#[derive(Clone, Copy, Debug)]
struct EmissiveCluster {
    key: ClusterKey,
    centroid_sum: Vec3,
    normal_sum: Vec3,
    area: f32,
    emission: [f32; 3],
}

impl EmissiveCluster {
    fn centroid(self) -> Vec3 {
        self.centroid_sum.scale(self.area.recip())
    }
}

#[derive(Clone, Copy, Debug)]
struct ComponentBounds {
    anchor: usize,
    material: usize,
    min: Vec3,
    max: Vec3,
}

#[derive(Clone, Copy, Debug)]
struct EmitterTriangle {
    component: usize,
    points: [Vec3; 3],
    centroid: Vec3,
    normal: Vec3,
    area: f32,
    emission: [f32; 3],
}

#[derive(Clone, Copy, Debug)]
struct SourceTriangle {
    vertices: [u32; 3],
    points: [[f32; 3]; 3],
}

#[derive(Clone, Copy)]
struct InferredLight {
    descriptor: EmbeddedPointLight,
    model_position: Vec3,
    flux: f32,
}

pub fn light_extraction_report(
    document: &GlbDocument,
    emissive_texture_means: &[Option<[f32; 3]>],
) -> LightExtractionReport {
    extract_lights(document, emissive_texture_means).1
}

pub fn extract_embedded_lights(
    document: &GlbDocument,
    emissive_texture_means: &[Option<[f32; 3]>],
) -> Result<Vec<EmbeddedPointLight>, LightExtractionReport> {
    let (lights, report) = extract_lights(document, emissive_texture_means);
    if report.errors == 0 {
        Ok(lights)
    } else {
        Err(report)
    }
}

fn extract_lights(
    document: &GlbDocument,
    emissive_texture_means: &[Option<[f32; 3]>],
) -> (Vec<EmbeddedPointLight>, LightExtractionReport) {
    let globals = document.node_globals();
    let mut report = LightExtractionReport::default();
    let mut lights = explicit_lights(document, &mut report);
    let explicit_positions = lights
        .iter()
        .map(|light| {
            globals
                .get(light.node)
                .copied()
                .unwrap_or(Mat4::IDENTITY)
                .mul(light.local)
                .transform_point(Vec3::ZERO)
        })
        .collect::<Vec<_>>();

    let clusters = emissive_clusters(document, &globals, emissive_texture_means, &mut report);

    let mut inferred = Vec::with_capacity(clusters.len());
    for cluster in clusters {
        report.candidates += 1;
        let luminance = linear_luminance(cluster.emission);
        let flux = luminance * cluster.area;
        if !flux.is_finite() || flux < MIN_EMISSIVE_LIGHT_FLUX {
            report.suppressed_low_flux += 1;
            continue;
        }

        let mut model_position = cluster.centroid();
        let normal_length = cluster.normal_sum.length();
        if normal_length > 1.0e-6 {
            model_position = model_position.add(
                cluster
                    .normal_sum
                    .scale(MAX_NORMAL_OFFSET_METERS / normal_length),
            );
        }

        let source_radius = cluster.area.sqrt().max(MERGE_DISTANCE_METERS);
        if explicit_positions.iter().any(|position| {
            distance_squared(*position, model_position) <= source_radius * source_radius
        }) {
            report.suppressed_duplicate += 1;
            continue;
        }

        let color = normalized_chroma(cluster.emission);
        let intensity =
            (flux * EMISSIVE_LIGHT_SCALE).clamp(MIN_INFERRED_INTENSITY, MAX_INFERRED_INTENSITY);
        let radius = derived_explicit_radius(color, intensity)
            .clamp(MIN_INFERRED_RADIUS_METERS, MAX_INFERRED_RADIUS_METERS);
        let anchor_global = globals
            .get(cluster.key.anchor)
            .copied()
            .unwrap_or(Mat4::IDENTITY);
        let local_position = anchor_global.inverse().transform_point(model_position);
        inferred.push(InferredLight {
            descriptor: EmbeddedPointLight {
                source: EmbeddedLightSource::Inferred,
                node: cluster.key.anchor,
                local: Mat4::from_translation(local_position),
                color,
                intensity,
                radius,
            },
            model_position,
            flux,
        });
    }

    inferred.sort_by(|left, right| {
        right
            .flux
            .total_cmp(&left.flux)
            .then_with(|| left.descriptor.node.cmp(&right.descriptor.node))
            .then_with(|| left.model_position.x.total_cmp(&right.model_position.x))
            .then_with(|| left.model_position.y.total_cmp(&right.model_position.y))
            .then_with(|| left.model_position.z.total_cmp(&right.model_position.z))
    });

    let available = MAX_LIGHTS_PER_MODEL.saturating_sub(lights.len());
    if inferred.len() > available {
        let overflow = inferred.len() - available;
        report.over_budget += overflow;
        report.errors += overflow;
        inferred.truncate(available);
    }
    lights.extend(inferred.into_iter().map(|light| light.descriptor));
    report.retained = lights.len();
    (lights, report)
}

fn explicit_lights(
    document: &GlbDocument,
    report: &mut LightExtractionReport,
) -> Vec<EmbeddedPointLight> {
    let mut lights = Vec::new();
    for (node_index, node) in document.nodes.iter().enumerate() {
        let Some(light_index) = node.light else {
            continue;
        };
        let Some(light) = document.lights.get(light_index) else {
            report.errors += 1;
            continue;
        };
        if light.kind != GlbLightKind::Point {
            continue;
        }
        if lights.len() >= MAX_LIGHTS_PER_MODEL {
            report.over_budget += 1;
            report.errors += 1;
            continue;
        }
        let radius = light
            .range
            .unwrap_or_else(|| derived_explicit_radius(light.color, light.intensity));
        report.explicit += 1;
        lights.push(EmbeddedPointLight {
            source: EmbeddedLightSource::Explicit,
            node: node_index,
            local: Mat4::IDENTITY,
            color: light.color,
            intensity: light.intensity,
            radius,
        });
    }
    lights
}

fn derived_explicit_radius(color: [f32; 3], intensity: f32) -> f32 {
    let contribution = intensity.max(0.0) * color[0].max(color[1]).max(color[2]);
    (contribution / DEFAULT_EXPLICIT_CUTOFF - 1.0)
        .max(0.0)
        .sqrt()
        .clamp(0.5, MAX_DERIVED_LIGHT_RADIUS_METERS)
}

fn emissive_clusters(
    document: &GlbDocument,
    globals: &[Mat4],
    emissive_texture_means: &[Option<[f32; 3]>],
    report: &mut LightExtractionReport,
) -> Vec<EmissiveCluster> {
    let mut triangles = Vec::new();
    let mut components = Vec::new();
    for (node_index, node) in document.nodes.iter().enumerate() {
        let Some(mesh_index) = node.mesh else {
            continue;
        };
        let Some(mesh) = document.meshes.get(mesh_index) else {
            report.errors += 1;
            continue;
        };
        let node_name = node.name.as_deref().unwrap_or("");
        let mesh_name = mesh.name.as_deref().unwrap_or("");
        let node_global = globals.get(node_index).copied().unwrap_or(Mat4::IDENTITY);

        for primitive in &mesh.primitives {
            let Some(material_index) = primitive.material else {
                continue;
            };
            let Some(material) = document.materials.get(material_index) else {
                report.errors += 1;
                continue;
            };
            let material_name = material.name.as_deref().unwrap_or("");
            if !has_emitter_semantics(node_name, mesh_name, material_name) {
                continue;
            }

            let texture_mean = emissive_texture_means
                .get(material_index)
                .copied()
                .flatten()
                .unwrap_or([1.0; 3]);
            let emission = [
                material.emissive_factor[0] * material.emissive_strength * texture_mean[0],
                material.emissive_factor[1] * material.emissive_strength * texture_mean[1],
                material.emissive_factor[2] * material.emissive_strength * texture_mean[2],
            ];
            if emission
                .iter()
                .all(|value| value.is_finite() && *value <= 0.0)
            {
                continue;
            }
            if emission
                .iter()
                .any(|value| !value.is_finite() || *value < 0.0)
            {
                report.errors += 1;
                continue;
            }

            let anchor =
                dominant_joint_anchor(document, node_index, primitive).unwrap_or(node_index);
            append_primitive_emitters(
                &mut triangles,
                &mut components,
                primitive,
                node_global,
                anchor,
                material_index,
                emission,
            );
        }
    }
    aggregate_emitter_components(triangles, components, report)
}

#[allow(clippy::too_many_arguments)]
fn append_primitive_emitters(
    emitters: &mut Vec<EmitterTriangle>,
    components: &mut Vec<ComponentBounds>,
    primitive: &GlbPrimitive,
    node_global: Mat4,
    anchor: usize,
    material: usize,
    emission: [f32; 3],
) {
    let positions = primitive.morphed_positions();
    let indexed = !primitive.indices.is_empty();
    let mut source = Vec::new();
    if indexed {
        source.reserve(primitive.indices.len() / 3);
        for triangle in primitive.indices.chunks_exact(3) {
            let Some(&a) = positions.get(triangle[0] as usize) else {
                continue;
            };
            let Some(&b) = positions.get(triangle[1] as usize) else {
                continue;
            };
            let Some(&c) = positions.get(triangle[2] as usize) else {
                continue;
            };
            source.push(SourceTriangle {
                vertices: [triangle[0], triangle[1], triangle[2]],
                points: [a, b, c],
            });
        }
    } else {
        source.reserve(positions.len() / 3);
        for (index, triangle) in positions.chunks_exact(3).enumerate() {
            let base = (index * 3) as u32;
            source.push(SourceTriangle {
                vertices: [base, base + 1, base + 2],
                points: [triangle[0], triangle[1], triangle[2]],
            });
        }
    }
    if source.is_empty() {
        return;
    }

    let mut parents = (0..source.len()).collect::<Vec<_>>();
    if indexed {
        let mut owner = vec![usize::MAX; positions.len()];
        for (triangle_index, triangle) in source.iter().enumerate() {
            for vertex in triangle.vertices {
                let slot = &mut owner[vertex as usize];
                if *slot != usize::MAX {
                    union_components(&mut parents, *slot, triangle_index);
                }
                *slot = triangle_index;
            }
        }
    }

    let mut component_ids = vec![usize::MAX; source.len()];
    for (triangle_index, triangle) in source.into_iter().enumerate() {
        let points = triangle
            .points
            .map(|point| node_global.transform_point(vec3(point[0], point[1], point[2])));
        let normal = points[1].sub(points[0]).cross(points[2].sub(points[0]));
        let area = normal.length() * 0.5;
        if !area.is_finite() || area <= 1.0e-8 {
            continue;
        }
        let root = find_component(&mut parents, triangle_index);
        let component = if component_ids[root] != usize::MAX {
            component_ids[root]
        } else {
            let component = components.len();
            components.push(ComponentBounds {
                anchor,
                material,
                min: points[0],
                max: points[0],
            });
            component_ids[root] = component;
            component
        };
        let bounds = &mut components[component];
        for point in points {
            bounds.min = vec3(
                bounds.min.x.min(point.x),
                bounds.min.y.min(point.y),
                bounds.min.z.min(point.z),
            );
            bounds.max = vec3(
                bounds.max.x.max(point.x),
                bounds.max.y.max(point.y),
                bounds.max.z.max(point.z),
            );
        }
        emitters.push(EmitterTriangle {
            component,
            points,
            centroid: points[0].add(points[1]).add(points[2]).scale(1.0 / 3.0),
            normal,
            area,
            emission,
        });
    }
}

fn aggregate_emitter_components(
    triangles: Vec<EmitterTriangle>,
    components: Vec<ComponentBounds>,
    report: &mut LightExtractionReport,
) -> Vec<EmissiveCluster> {
    if components.is_empty() {
        return Vec::new();
    }
    let mut parents = (0..components.len()).collect::<Vec<_>>();
    let mut ordered = (0..components.len()).collect::<Vec<_>>();
    ordered.sort_unstable_by(|left, right| {
        components[*left]
            .anchor
            .cmp(&components[*right].anchor)
            .then_with(|| components[*left].material.cmp(&components[*right].material))
            .then_with(|| components[*left].min.x.total_cmp(&components[*right].min.x))
            .then_with(|| left.cmp(right))
    });
    let mut active = Vec::<usize>::new();
    let mut group = None;
    for index in ordered {
        let key = (components[index].anchor, components[index].material);
        if group != Some(key) {
            active.clear();
            group = Some(key);
        }
        active.retain(|other| {
            components[*other].max.x + MERGE_DISTANCE_METERS >= components[index].min.x
        });
        for &other in &active {
            if bounds_distance_squared(components[index], components[other])
                <= MERGE_DISTANCE_METERS * MERGE_DISTANCE_METERS
            {
                union_components(&mut parents, index, other);
            }
        }
        active.push(index);
    }

    let mut merged_bounds = vec![None; components.len()];
    for (index, bounds) in components.into_iter().enumerate() {
        let root = find_component(&mut parents, index);
        if let Some(merged) = merged_bounds[root].as_mut() {
            merge_bounds(merged, bounds);
        } else {
            merged_bounds[root] = Some(bounds);
        }
    }

    let mut clusters = BTreeMap::<ClusterKey, EmissiveCluster>::new();
    for triangle in triangles {
        let root = find_component(&mut parents, triangle.component);
        let bounds = merged_bounds[root].expect("emitter component bounds");
        let span = bounds.max.sub(bounds.min);
        let split =
            span.x > CELL_SIZE_METERS || span.y > CELL_SIZE_METERS || span.z > CELL_SIZE_METERS;
        if !split {
            accumulate_cluster(
                &mut clusters,
                ClusterKey {
                    anchor: bounds.anchor,
                    material: bounds.material,
                    component: root,
                    cell_x: 0,
                    cell_y: 0,
                    cell_z: 0,
                },
                triangle.centroid,
                triangle.normal,
                triangle.area,
                triangle.emission,
            );
            continue;
        }

        let min_x = triangle
            .points
            .iter()
            .map(|point| cell_coord(point.x))
            .min()
            .unwrap_or(0);
        let max_x = triangle
            .points
            .iter()
            .map(|point| cell_coord(point.x))
            .max()
            .unwrap_or(0);
        let min_y = triangle
            .points
            .iter()
            .map(|point| cell_coord(point.y))
            .min()
            .unwrap_or(0);
        let max_y = triangle
            .points
            .iter()
            .map(|point| cell_coord(point.y))
            .max()
            .unwrap_or(0);
        let min_z = triangle
            .points
            .iter()
            .map(|point| cell_coord(point.z))
            .min()
            .unwrap_or(0);
        let max_z = triangle
            .points
            .iter()
            .map(|point| cell_coord(point.z))
            .max()
            .unwrap_or(0);
        let clip_tests = i64::from(max_x - min_x + 1)
            * i64::from(max_y - min_y + 1)
            * i64::from(max_z - min_z + 1);
        if clip_tests > 4096 {
            report.over_budget += 1;
            report.errors += 1;
            continue;
        }
        for cell_x in min_x..=max_x {
            for cell_y in min_y..=max_y {
                for cell_z in min_z..=max_z {
                    let Some((centroid, normal, area)) =
                        clip_triangle_to_cell(triangle.points, cell_x, cell_y, cell_z)
                    else {
                        continue;
                    };
                    accumulate_cluster(
                        &mut clusters,
                        ClusterKey {
                            anchor: bounds.anchor,
                            material: bounds.material,
                            component: root,
                            cell_x,
                            cell_y,
                            cell_z,
                        },
                        centroid,
                        normal,
                        area,
                        triangle.emission,
                    );
                }
            }
        }
    }
    clusters.into_values().collect()
}

fn accumulate_cluster(
    clusters: &mut BTreeMap<ClusterKey, EmissiveCluster>,
    key: ClusterKey,
    centroid: Vec3,
    normal: Vec3,
    area: f32,
    emission: [f32; 3],
) {
    let cluster = clusters.entry(key).or_insert(EmissiveCluster {
        key,
        centroid_sum: Vec3::ZERO,
        normal_sum: Vec3::ZERO,
        area: 0.0,
        emission,
    });
    cluster.centroid_sum = cluster.centroid_sum.add(centroid.scale(area));
    cluster.normal_sum = cluster.normal_sum.add(normal);
    cluster.area += area;
}

fn clip_triangle_to_cell(
    points: [Vec3; 3],
    cell_x: i32,
    cell_y: i32,
    cell_z: i32,
) -> Option<(Vec3, Vec3, f32)> {
    let mut polygon = points.to_vec();
    for (axis, cell) in [(0, cell_x), (1, cell_y), (2, cell_z)] {
        let lower = cell as f32 * CELL_SIZE_METERS;
        polygon = clip_polygon_axis(&polygon, axis, lower, true);
        if polygon.len() < 3 {
            return None;
        }
        polygon = clip_polygon_axis(&polygon, axis, lower + CELL_SIZE_METERS, false);
        if polygon.len() < 3 {
            return None;
        }
    }

    let origin = polygon[0];
    let mut centroid_sum = Vec3::ZERO;
    let mut normal_sum = Vec3::ZERO;
    let mut area = 0.0;
    for index in 1..polygon.len() - 1 {
        let left = polygon[index];
        let right = polygon[index + 1];
        let normal = left.sub(origin).cross(right.sub(origin));
        let triangle_area = normal.length() * 0.5;
        if triangle_area <= 1.0e-8 {
            continue;
        }
        let centroid = origin.add(left).add(right).scale(1.0 / 3.0);
        centroid_sum = centroid_sum.add(centroid.scale(triangle_area));
        normal_sum = normal_sum.add(normal);
        area += triangle_area;
    }
    if !area.is_finite() || area <= 1.0e-8 {
        None
    } else {
        Some((centroid_sum.scale(area.recip()), normal_sum, area))
    }
}

fn clip_polygon_axis(input: &[Vec3], axis: usize, bound: f32, keep_greater: bool) -> Vec<Vec3> {
    let mut output = Vec::with_capacity(input.len() + 1);
    let Some(mut previous) = input.last().copied() else {
        return output;
    };
    let mut previous_value = vector_axis(previous, axis);
    let mut previous_inside = if keep_greater {
        previous_value >= bound
    } else {
        previous_value <= bound
    };
    for &current in input {
        let current_value = vector_axis(current, axis);
        let current_inside = if keep_greater {
            current_value >= bound
        } else {
            current_value <= bound
        };
        if current_inside != previous_inside {
            let amount = (bound - previous_value) / (current_value - previous_value);
            output.push(previous.add(current.sub(previous).scale(amount)));
        }
        if current_inside {
            output.push(current);
        }
        previous = current;
        previous_value = current_value;
        previous_inside = current_inside;
    }
    output
}

fn vector_axis(value: Vec3, axis: usize) -> f32 {
    match axis {
        0 => value.x,
        1 => value.y,
        _ => value.z,
    }
}

fn find_component(parents: &mut [usize], mut index: usize) -> usize {
    while parents[index] != index {
        parents[index] = parents[parents[index]];
        index = parents[index];
    }
    index
}

fn union_components(parents: &mut [usize], left: usize, right: usize) {
    let left = find_component(parents, left);
    let right = find_component(parents, right);
    if left == right {
        return;
    }
    let (root, child) = if left < right {
        (left, right)
    } else {
        (right, left)
    };
    parents[child] = root;
}

fn bounds_distance_squared(left: ComponentBounds, right: ComponentBounds) -> f32 {
    let x = (left.min.x - right.max.x)
        .max(right.min.x - left.max.x)
        .max(0.0);
    let y = (left.min.y - right.max.y)
        .max(right.min.y - left.max.y)
        .max(0.0);
    let z = (left.min.z - right.max.z)
        .max(right.min.z - left.max.z)
        .max(0.0);
    x * x + y * y + z * z
}

fn merge_bounds(target: &mut ComponentBounds, source: ComponentBounds) {
    target.min = vec3(
        target.min.x.min(source.min.x),
        target.min.y.min(source.min.y),
        target.min.z.min(source.min.z),
    );
    target.max = vec3(
        target.max.x.max(source.max.x),
        target.max.y.max(source.max.y),
        target.max.z.max(source.max.z),
    );
}

fn dominant_joint_anchor(
    document: &GlbDocument,
    mesh_node: usize,
    primitive: &GlbPrimitive,
) -> Option<usize> {
    let skin_index = document.nodes.get(mesh_node)?.skin?;
    let skin = document.skins.get(skin_index)?;
    if primitive.joints.len() != primitive.weights.len() || skin.joints.is_empty() {
        return None;
    }
    let mut totals = vec![0.0f32; skin.joints.len()];
    for (joints, weights) in primitive.joints.iter().zip(&primitive.weights) {
        for (&joint, &weight) in joints.iter().zip(weights) {
            if let Some(total) = totals.get_mut(joint as usize) {
                *total += weight.max(0.0);
            }
        }
    }
    let dominant = totals
        .iter()
        .enumerate()
        .max_by(|left, right| left.1.total_cmp(right.1))?
        .0;
    skin.joints.get(dominant).copied()
}

fn has_emitter_semantics(node: &str, mesh: &str, material: &str) -> bool {
    [node, mesh, material].iter().any(|value| {
        EMITTER_TOKENS
            .iter()
            .any(|token| contains_ascii_case_insensitive(value, token))
    })
}

fn contains_ascii_case_insensitive(value: &str, token: &str) -> bool {
    value
        .as_bytes()
        .windows(token.len())
        .any(|window| window.eq_ignore_ascii_case(token.as_bytes()))
}

fn cell_coord(value: f32) -> i32 {
    (value / CELL_SIZE_METERS).floor() as i32
}

fn normalized_chroma(emission: [f32; 3]) -> [f32; 3] {
    let max = emission[0].max(emission[1]).max(emission[2]);
    if max <= 1.0e-6 {
        [0.0; 3]
    } else {
        [emission[0] / max, emission[1] / max, emission[2] / max]
    }
}

fn linear_luminance(color: [f32; 3]) -> f32 {
    color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722
}

fn distance_squared(left: Vec3, right: Vec3) -> f32 {
    let delta = left.sub(right);
    delta.dot(delta)
}

pub fn upload_static_model<G: Gpu>(
    gpu: &mut G,
    renderer: &mut Renderer,
    bytes: &[u8],
) -> Result<StaticModel, glb::GlbError> {
    let document = glb::parse(bytes)?;
    upload_static_document(gpu, renderer, &document)
}

fn upload_static_document<G: Gpu>(
    gpu: &mut G,
    renderer: &mut Renderer,
    document: &GlbDocument,
) -> Result<StaticModel, glb::GlbError> {
    let prepared = successor_engine_render::model::prepare_glb(document)
        .map_err(|_| glb::GlbError::Unsupported("model upload"))?;
    let (mut lights, report) = extract_lights(document, &prepared.material_emissive_texture_means);
    if report.errors != 0 {
        return Err(glb::GlbError::Unsupported("model point lights"));
    }
    let uploaded =
        successor_engine_render::model::upload_prepared_glb(renderer, gpu, document, prepared)
            .map_err(|_| glb::GlbError::Unsupported("model upload"))?;
    let globals = document.node_globals();
    let mut parts = Vec::new();
    for (node_index, node) in document.nodes.iter().enumerate() {
        let Some(mesh_index) = node.mesh else {
            continue;
        };
        for primitive in uploaded
            .primitives
            .iter()
            .filter(|primitive| primitive.source_mesh == mesh_index)
        {
            parts.push(StaticPart {
                mesh: primitive.mesh,
                material: primitive.material,
                local: globals.get(node_index).copied().unwrap_or(Mat4::IDENTITY),
            });
        }
    }

    for light in &mut lights {
        light.local = globals
            .get(light.node)
            .copied()
            .unwrap_or(Mat4::IDENTITY)
            .mul(light.local);
    }
    Ok(StaticModel { parts, lights })
}

#[cfg(test)]
mod tests {
    use super::{
        extract_embedded_lights, light_extraction_report, upload_static_document,
        EmbeddedLightSource, MAX_LIGHTS_PER_MODEL,
    };
    use std::path::{Path, PathBuf};
    use successor_engine_core::glb;

    fn corpus_path(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join("client-3d/public/assets/world-items")
            .join(name)
    }

    fn material_emissive_means(document: &glb::GlbDocument) -> Vec<Option<[f32; 3]>> {
        let image_means = document
            .images
            .iter()
            .map(|image| {
                successor_engine_core::image::decode_image(&image.mime_type, &image.bytes)
                    .ok()
                    .map(|decoded| {
                        successor_engine_render::model::emissive_texture_mean_linear(
                            &decoded.pixels,
                        )
                    })
            })
            .collect::<Vec<_>>();
        document
            .materials
            .iter()
            .map(|material| {
                material
                    .emissive_texture
                    .and_then(|reference| document.textures.get(reference.texture))
                    .and_then(|texture| image_means.get(texture.source))
                    .copied()
                    .flatten()
            })
            .collect()
    }

    fn load(
        name: &str,
    ) -> (
        glb::GlbDocument,
        Vec<Option<[f32; 3]>>,
        super::LightExtractionReport,
    ) {
        let bytes = std::fs::read(corpus_path(name)).expect("read checked-in GLB");
        let document = glb::parse(&bytes).expect("parse checked-in GLB");
        let means = material_emissive_means(&document);
        let report = light_extraction_report(&document, &means);
        (document, means, report)
    }

    #[test]
    fn home_modular_starter_retains_warm_lampglow_emitters() {
        let (document, means, report) = load("home_modular_starter.glb");
        assert_eq!(report.errors, 0);
        assert!(report.candidates >= 4);
        assert!(report.retained >= 4);
        let lights = extract_embedded_lights(&document, &means).expect("valid home lights");
        assert!(lights.iter().any(|light| {
            light.source == EmbeddedLightSource::Inferred
                && light.color[0] >= light.color[1]
                && light.color[0] > light.color[2]
        }));
    }

    #[test]
    fn clone_terminal_retains_cyan_and_amber_emitters() {
        let (document, means, report) = load("clone_terminal.glb");
        assert_eq!(report.errors, 0);
        assert!(report.candidates >= 2);
        let lights = extract_embedded_lights(&document, &means).expect("valid terminal lights");
        assert!(lights.iter().any(|light| {
            light.source == EmbeddedLightSource::Inferred && light.color[2] > light.color[0]
        }));
        assert!(lights.iter().any(|light| {
            light.source == EmbeddedLightSource::Inferred && light.color[0] > light.color[2]
        }));
    }

    #[test]
    fn facility_emitters_split_into_bounded_local_clusters() {
        let (document, means, report) = load("cloning_facility.glb");
        assert_eq!(report.errors, 0);
        assert!(report.candidates > 1);
        assert!(report.retained > 1);
        assert!(report.retained <= MAX_LIGHTS_PER_MODEL);
        let globals = document.node_globals();
        let lights = extract_embedded_lights(&document, &means).expect("valid facility lights");
        assert!(lights.iter().all(|light| light.radius <= 12.0));
        let positions = lights
            .iter()
            .map(|light| {
                globals[light.node]
                    .mul(light.local)
                    .transform_point(successor_engine_core::math::Vec3::ZERO)
            })
            .collect::<Vec<_>>();
        let mut spread_squared = 0.0f32;
        for (index, left) in positions.iter().enumerate() {
            for right in &positions[index + 1..] {
                let delta = left.sub(*right);
                spread_squared = spread_squared.max(delta.dot(delta));
            }
        }
        assert!(
            spread_squared > 4.0,
            "facility emitters collapsed to one center"
        );
    }

    #[test]
    fn campfire_texture_mean_preserves_warm_emission_color() {
        let (document, means, report) = load("campfire_frontier.glb");
        assert_eq!(report.errors, 0);
        let lights = extract_embedded_lights(&document, &means).expect("valid campfire lights");
        assert!(lights.iter().any(|light| {
            light.source == EmbeddedLightSource::Inferred
                && light.color[0] > light.color[1]
                && light.color[1] > light.color[2]
        }));
    }

    #[test]
    fn tiny_emissive_geometry_does_not_create_point_lights() {
        let (mut document, means, _) = load("clone_terminal.glb");
        for material in &mut document.materials {
            material.emissive_factor = [1.0e-10; 3];
            material.emissive_strength = 1.0;
        }
        let report = light_extraction_report(&document, &means);
        assert!(report.candidates > 0);
        assert_eq!(report.retained, 0);
        assert_eq!(report.suppressed_low_flux, report.candidates);
        assert_eq!(report.errors, 0);
    }

    #[test]
    fn authored_point_range_is_preserved_without_inference_clamping() {
        let (mut document, _, _) = load("clone_terminal.glb");
        let mut node = document.nodes.first().expect("model node").clone();
        node.children.clear();
        node.mesh = None;
        node.skin = None;
        node.light = Some(0);
        document.nodes = vec![node];
        document.lights = vec![glb::GlbPunctualLight {
            name: Some("long-range".to_string()),
            kind: glb::GlbLightKind::Point,
            color: [1.0, 0.8, 0.6],
            intensity: 2.0,
            range: Some(64.0),
        }];

        let lights = extract_embedded_lights(&document, &[]).expect("valid authored range");
        assert_eq!(lights.len(), 1);
        assert_eq!(lights[0].radius, 64.0);
    }

    #[test]
    fn wide_triangles_are_clipped_across_two_meter_cells() {
        let points = [
            successor_engine_core::math::vec3(0.0, 0.0, 0.0),
            successor_engine_core::math::vec3(10.0, 0.0, 0.0),
            successor_engine_core::math::vec3(10.0, 1.0, 0.0),
        ];
        let second = [
            points[0],
            points[2],
            successor_engine_core::math::vec3(0.0, 1.0, 0.0),
        ];
        let triangles = vec![
            super::EmitterTriangle {
                component: 0,
                points,
                centroid: points[0].add(points[1]).add(points[2]).scale(1.0 / 3.0),
                normal: points[1].sub(points[0]).cross(points[2].sub(points[0])),
                area: 5.0,
                emission: [1.0; 3],
            },
            super::EmitterTriangle {
                component: 0,
                points: second,
                centroid: second[0].add(second[1]).add(second[2]).scale(1.0 / 3.0),
                normal: second[1].sub(second[0]).cross(second[2].sub(second[0])),
                area: 5.0,
                emission: [1.0; 3],
            },
        ];
        let components = vec![super::ComponentBounds {
            anchor: 0,
            material: 0,
            min: points[0],
            max: successor_engine_core::math::vec3(10.0, 1.0, 0.0),
        }];
        let mut report = super::LightExtractionReport::default();
        let clusters = super::aggregate_emitter_components(triangles, components, &mut report);

        assert_eq!(report.errors, 0);
        assert_eq!(clusters.len(), 5);
        let total_area = clusters.iter().map(|cluster| cluster.area).sum::<f32>();
        assert!((total_area - 10.0).abs() < 1.0e-4);
    }

    #[test]
    fn explicit_light_budget_overflow_fails_model_extraction() {
        let (mut document, _, _) = load("clone_terminal.glb");
        let template = document.nodes.first().expect("model node").clone();
        document.lights = (0..=MAX_LIGHTS_PER_MODEL)
            .map(|index| glb::GlbPunctualLight {
                name: Some(format!("point-{index}")),
                kind: glb::GlbLightKind::Point,
                color: [1.0, 0.8, 0.6],
                intensity: 2.0,
                range: Some(4.0),
            })
            .collect();
        document.nodes = (0..=MAX_LIGHTS_PER_MODEL)
            .map(|light| {
                let mut node = template.clone();
                node.children.clear();
                node.mesh = None;
                node.skin = None;
                node.light = Some(light);
                node
            })
            .collect();

        let report = light_extraction_report(&document, &[]);
        assert_eq!(report.explicit, MAX_LIGHTS_PER_MODEL);
        assert_eq!(report.retained, MAX_LIGHTS_PER_MODEL);
        assert_eq!(report.over_budget, 1);
        assert_eq!(report.errors, 1);
        assert_eq!(extract_embedded_lights(&document, &[]), Err(report));
    }
    #[test]
    fn light_budget_failure_precedes_gpu_resource_upload() {
        let (mut document, _, _) = load("clone_terminal.glb");
        let template = document.nodes.first().expect("model node").clone();
        document.lights = (0..=MAX_LIGHTS_PER_MODEL)
            .map(|index| glb::GlbPunctualLight {
                name: Some(format!("point-{index}")),
                kind: glb::GlbLightKind::Point,
                color: [1.0, 0.8, 0.6],
                intensity: 2.0,
                range: Some(4.0),
            })
            .collect();
        document.nodes = (0..=MAX_LIGHTS_PER_MODEL)
            .map(|light| {
                let mut node = template.clone();
                node.children.clear();
                node.mesh = None;
                node.skin = None;
                node.light = Some(light);
                node
            })
            .collect();

        let mut gpu = successor_engine_render::gpu::MockGpu::default();
        let mut renderer = successor_engine_render::renderer::Renderer::new(
            &mut gpu,
            successor_engine_render::renderer::RendererLimits::default(),
        )
        .expect("renderer");
        let resources_before = gpu.resources_created();

        assert!(matches!(
            upload_static_document(&mut gpu, &mut renderer, &document),
            Err(glb::GlbError::Unsupported("model point lights"))
        ));
        assert_eq!(gpu.resources_created(), resources_before);
    }
}

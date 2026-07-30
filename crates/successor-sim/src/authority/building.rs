use super::*;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use successor_net::BuildPalette;

const BUILD_STRUCTURAL_ITEM_ID: u32 = RESOURCE_CREATURE_STRUCTURAL_ITEM_ID;
const BUILD_MECHANICAL_ITEM_ID: u32 = RESOURCE_CHEMICAL_ITEM_ID;
const BUILD_GLASS_ITEM_ID: u32 = RESOURCE_CARBON_ITEM_ID;
const BUILD_SALVAGE_NUMERATOR: u32 = 1;
const BUILD_SALVAGE_DENOMINATOR: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct BuildCatalogEntry {
    pub(super) id: &'static str,
    pub(super) kind: &'static str,
    pub(super) span_x: i32,
    pub(super) span_y: i32,
    pub(super) structural: u32,
    pub(super) mechanical: u32,
    pub(super) glass: u32,
}

const BUILD_CATALOG: [BuildCatalogEntry; 5] = [
    BuildCatalogEntry {
        id: "floor_1x1",
        kind: "floor",
        span_x: 1,
        span_y: 1,
        structural: 2,
        mechanical: 0,
        glass: 0,
    },
    BuildCatalogEntry {
        id: "wall_1m",
        kind: "wall",
        span_x: 1,
        span_y: 0,
        structural: 2,
        mechanical: 0,
        glass: 0,
    },
    BuildCatalogEntry {
        id: "door_slide_1m",
        kind: "door",
        span_x: 1,
        span_y: 0,
        structural: 3,
        mechanical: 1,
        glass: 0,
    },
    BuildCatalogEntry {
        id: "window_1m",
        kind: "window",
        span_x: 1,
        span_y: 0,
        structural: 2,
        mechanical: 0,
        glass: 1,
    },
    BuildCatalogEntry {
        id: "roof_1x1",
        kind: "roof",
        span_x: 1,
        span_y: 1,
        structural: 2,
        mechanical: 0,
        glass: 0,
    },
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BuildComponentState {
    pub(super) component_id: String,
    pub(super) owner_actor_id: String,
    pub(super) area_id: String,
    pub(super) parcel_id: String,
    pub(super) catalog_id: String,
    pub(super) kind: String,
    pub(super) cell_x: i32,
    pub(super) cell_y: i32,
    pub(super) rotation_quarters: u8,
    #[serde(default)]
    pub(super) palette: BuildPalette,
    #[serde(default)]
    pub(super) door_open: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBuildComponentSnapshot {
    pub component_id: String,
    pub owner_actor_id: String,
    pub area_id: String,
    pub parcel_id: String,
    pub catalog_id: String,
    pub kind: String,
    pub cell_x: i32,
    pub cell_y: i32,
    pub rotation_quarters: u8,
    pub palette: BuildPalette,
    pub door_open: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityInteriorRegionSnapshot {
    pub interior_id: String,
    pub area_id: String,
    pub parcel_id: String,
    pub cell_keys: Vec<String>,
    pub roofed: bool,
    pub enclosed: bool,
    pub door_component_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorityBuildDeltaPayload {
    pub schema: String,
    pub tick: u64,
    pub components: Vec<AuthorityBuildComponentSnapshot>,
    pub interiors: Vec<AuthorityInteriorRegionSnapshot>,
}

impl BuildComponentState {
    fn snapshot(&self) -> AuthorityBuildComponentSnapshot {
        AuthorityBuildComponentSnapshot {
            component_id: self.component_id.clone(),
            owner_actor_id: self.owner_actor_id.clone(),
            area_id: self.area_id.clone(),
            parcel_id: self.parcel_id.clone(),
            catalog_id: self.catalog_id.clone(),
            kind: self.kind.clone(),
            cell_x: self.cell_x,
            cell_y: self.cell_y,
            rotation_quarters: self.rotation_quarters,
            palette: self.palette.clone(),
            door_open: self.door_open,
        }
    }
}

fn catalog_entry(id: &str) -> Option<BuildCatalogEntry> {
    BUILD_CATALOG.iter().copied().find(|entry| entry.id == id)
}

fn edge_key(cell_x: i32, cell_y: i32, rotation: u8) -> (i32, i32, u8) {
    (cell_x, cell_y, rotation % 4)
}

fn component_occupies_tile(component: &BuildComponentState, x: i32, y: i32) -> bool {
    matches!(component.kind.as_str(), "floor" | "roof")
        && component.cell_x == x
        && component.cell_y == y
}

fn component_edge(component: &BuildComponentState) -> Option<(i32, i32, u8)> {
    if matches!(component.kind.as_str(), "wall" | "door" | "window") {
        Some(edge_key(
            component.cell_x,
            component.cell_y,
            component.rotation_quarters,
        ))
    } else {
        None
    }
}

fn consume_costs(
    state: &mut SliceAuthorityState,
    actor_id: &str,
    entry: BuildCatalogEntry,
) -> Result<(), AuthorityRejectReason> {
    let needs = [
        (BUILD_STRUCTURAL_ITEM_ID, entry.structural),
        (BUILD_MECHANICAL_ITEM_ID, entry.mechanical),
        (BUILD_GLASS_ITEM_ID, entry.glass),
    ];
    if needs
        .iter()
        .any(|(item, qty)| state.actor_inventory_available_quantity(actor_id, *item) < *qty)
    {
        return Err(AuthorityRejectReason::IngredientUnavailable);
    }
    for (item, qty) in needs {
        if qty > 0 {
            state.consume_actor_inventory_quantity(actor_id, item, qty)?;
        }
    }
    Ok(())
}

fn refund_costs(state: &mut SliceAuthorityState, actor_id: &str, entry: BuildCatalogEntry) {
    let rows = [
        (BUILD_STRUCTURAL_ITEM_ID, entry.structural),
        (BUILD_MECHANICAL_ITEM_ID, entry.mechanical),
        (BUILD_GLASS_ITEM_ID, entry.glass),
    ];
    for (item, qty) in rows {
        let qty = qty.saturating_mul(BUILD_SALVAGE_NUMERATOR) / BUILD_SALVAGE_DENOMINATOR;
        if qty == 0 {
            continue;
        }
        if let Some(name) = inventory_item_name(item) {
            state.add_actor_inventory_stack(
                actor_id,
                item,
                0,
                name,
                qty,
                RESOURCE_STACK_CAP,
                "field-pack",
            );
        }
    }
}

impl SliceAuthorityState {
    pub(super) fn apply_build_place(
        &mut self,
        config: &SliceAuthorityConfig,
        catalog_id: &str,
        parcel_id: &str,
        cell_x: i32,
        cell_y: i32,
        rotation: u8,
        palette: Option<&BuildPalette>,
    ) -> Result<(), AuthorityRejectReason> {
        let entry = catalog_entry(catalog_id).ok_or(AuthorityRejectReason::UnknownSchematic)?;
        if rotation > 3 {
            return Err(AuthorityRejectReason::OutOfBounds);
        }
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        let owner = self.require_parcel_owner(config, parcel_id)?;
        if owner != actor.id {
            return Err(AuthorityRejectReason::NotParcelOwner);
        }
        let parcel = self
            .runtime
            .durable
            .parcels
            .get(parcel_id)
            .ok_or(AuthorityRejectReason::UnknownParcel)?;
        if parcel.area_id != actor.area_id {
            return Err(AuthorityRejectReason::OutOfBounds);
        }
        let tile = AuthorityCell::new(cell_x, cell_y);
        if !parcel.build_zone.contains_cell(tile) {
            return Err(AuthorityRejectReason::OutOfBounds);
        }
        if entry.kind == "floor" || entry.kind == "roof" {
            if parcel
                .build_components
                .values()
                .any(|c| component_occupies_tile(c, cell_x, cell_y) && c.kind == entry.kind)
            {
                return Err(AuthorityRejectReason::StructureFootprintBlocked);
            }
        } else if parcel
            .build_components
            .values()
            .any(|c| component_edge(c) == Some(edge_key(cell_x, cell_y, rotation)))
        {
            return Err(AuthorityRejectReason::StructureFootprintBlocked);
        }
        consume_costs(self, &actor.id, entry)?;
        let seq = self.runtime.durable.next_build_component_id.max(1);
        self.runtime.durable.next_build_component_id = seq.saturating_add(1).max(1);
        let component_id = format!("build:{parcel_id}:{seq}");
        let component = BuildComponentState {
            component_id: component_id.clone(),
            owner_actor_id: actor.id.clone(),
            area_id: actor.area_id.clone(),
            parcel_id: parcel_id.to_owned(),
            catalog_id: entry.id.to_owned(),
            kind: entry.kind.to_owned(),
            cell_x,
            cell_y,
            rotation_quarters: rotation,
            palette: palette.cloned().unwrap_or_default(),
            door_open: false,
        };
        self.runtime
            .durable
            .parcels
            .get_mut(parcel_id)
            .expect("parcel validated")
            .build_components
            .insert(component_id, component);
        Ok(())
    }

    pub(super) fn apply_build_remove(
        &mut self,
        config: &SliceAuthorityConfig,
        component_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let owner = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .id
            .clone();
        let (parcel_id, component) = self
            .runtime
            .durable
            .parcels
            .iter()
            .find_map(|(id, parcel)| {
                parcel
                    .build_components
                    .get(component_id)
                    .cloned()
                    .map(|c| (id.clone(), c))
            })
            .ok_or(AuthorityRejectReason::UnknownParcel)?;
        if component.owner_actor_id != owner {
            return Err(AuthorityRejectReason::NotParcelOwner);
        }
        let entry =
            catalog_entry(&component.catalog_id).ok_or(AuthorityRejectReason::UnknownSchematic)?;
        let parcel = self
            .runtime
            .durable
            .parcels
            .get_mut(&parcel_id)
            .expect("component parcel");
        parcel.build_components.remove(component_id);
        refund_costs(self, &owner, entry);
        Ok(())
    }

    pub(super) fn apply_build_toggle_door(
        &mut self,
        config: &SliceAuthorityConfig,
        component_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let owner = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .id
            .clone();
        for parcel in self.runtime.durable.parcels.values_mut() {
            if let Some(component) = parcel.build_components.get_mut(component_id) {
                if component.owner_actor_id != owner {
                    return Err(AuthorityRejectReason::NotParcelOwner);
                }
                if component.kind != "door" {
                    return Err(AuthorityRejectReason::TargetUnavailable);
                }
                component.door_open = !component.door_open;
                return Ok(());
            }
        }
        Err(AuthorityRejectReason::UnknownParcel)
    }

    pub(crate) fn build_delta_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> AuthorityBuildDeltaPayload {
        let observer = self.runtime.durable.actors.get(&config.player_actor_id);
        let visible = |parcel: &&ParcelAuthorityState| match observer {
            Some(actor) => {
                self.parcel_in_interest(actor, parcel, config.area_interest_radius_cells)
            }
            None => true,
        };
        let components = self
            .runtime
            .durable
            .parcels
            .values()
            .filter(visible)
            .flat_map(|parcel| parcel.build_components.values())
            .map(BuildComponentState::snapshot)
            .collect::<Vec<_>>();
        let interiors = self
            .interior_regions(observer, config)
            .into_values()
            .collect();
        AuthorityBuildDeltaPayload {
            schema: "successor.authority-building.v1".to_owned(),
            tick: self.runtime.durable.tick,
            components,
            interiors,
        }
    }

    fn interior_regions(
        &self,
        observer: Option<&ActorAuthorityState>,
        config: &SliceAuthorityConfig,
    ) -> BTreeMap<String, AuthorityInteriorRegionSnapshot> {
        let mut out = BTreeMap::new();
        for parcel in self
            .runtime
            .durable
            .parcels
            .values()
            .filter(|parcel| match observer {
                Some(actor) => {
                    self.parcel_in_interest(actor, parcel, config.area_interest_radius_cells)
                }
                None => true,
            })
        {
            let floors = parcel
                .build_components
                .values()
                .filter(|c| c.kind == "floor")
                .collect::<Vec<_>>();
            let floor_keys = floors
                .iter()
                .map(|c| (c.cell_x, c.cell_y))
                .collect::<BTreeSet<_>>();
            let mut unseen = floor_keys.clone();
            while let Some(&start) = unseen.iter().next() {
                let mut queue = VecDeque::from([start]);
                let mut cells = BTreeSet::new();
                while let Some(cell) = queue.pop_front() {
                    if !unseen.remove(&cell) {
                        continue;
                    }
                    cells.insert(cell);
                    for (dx, dy, side) in [(0, -1, 0), (1, 0, 1), (0, 1, 2), (-1, 0, 3)] {
                        let next = (cell.0 + dx, cell.1 + dy);
                        if !floor_keys.contains(&next) {
                            continue;
                        }
                        let blocked = parcel
                            .build_components
                            .values()
                            .any(|c| component_edge(c) == Some(edge_key(cell.0, cell.1, side)));
                        if !blocked {
                            queue.push_back(next);
                        }
                    }
                }
                let mut enclosed = true;
                let mut roofed = true;
                let mut doors = Vec::new();
                for &(x, y) in &cells {
                    roofed &= parcel
                        .build_components
                        .values()
                        .any(|c| c.kind == "roof" && c.cell_x == x && c.cell_y == y);
                    for (dx, dy, side) in [(0, -1, 0), (1, 0, 1), (0, 1, 2), (-1, 0, 3)] {
                        let edge = edge_key(x, y, side);
                        if let Some(boundary) = parcel
                            .build_components
                            .values()
                            .find(|c| component_edge(c) == Some(edge))
                        {
                            if boundary.kind == "door" {
                                doors.push(boundary.component_id.clone());
                            }
                        } else if !floor_keys.contains(&(x + dx, y + dy)) {
                            enclosed = false;
                        }
                    }
                }
                let cell_keys = cells
                    .iter()
                    .map(|(x, y)| format!("{x}:{y}"))
                    .collect::<Vec<_>>();
                let key = cell_keys.join(",");
                let interior_id = format!(
                    "interior:{:08x}",
                    string_hash32(&format!("{}:{}:{}", parcel.area_id, parcel.id, key))
                );
                doors.sort();
                doors.dedup();
                out.insert(
                    interior_id.clone(),
                    AuthorityInteriorRegionSnapshot {
                        interior_id,
                        area_id: parcel.area_id.clone(),
                        parcel_id: parcel.id.clone(),
                        cell_keys,
                        roofed,
                        enclosed,
                        door_component_ids: doors,
                    },
                );
            }
        }
        out
    }

    pub(super) fn build_circle_blockers_for_area(
        &self,
        area_id: &str,
    ) -> Vec<crate::authority::swept_circle::CircleAabb> {
        let mut out = Vec::new();
        for parcel in self
            .runtime
            .durable
            .parcels
            .values()
            .filter(|p| p.area_id == area_id)
        {
            for component in parcel.build_components.values().filter(|c| {
                c.kind == "wall" || c.kind == "window" || (c.kind == "door" && !c.door_open)
            }) {
                let x = component.cell_x.saturating_mul(MILLI_CELLS_PER_CELL);
                let y = component.cell_y.saturating_mul(MILLI_CELLS_PER_CELL);
                let box_ = match component.rotation_quarters % 4 {
                    0 => (x, y - 50, x + 1000, y + 50),
                    1 => (x + 950, y, x + 1050, y + 1000),
                    2 => (x, y + 950, x + 1000, y + 1050),
                    _ => (x - 50, y, x + 50, y + 1000),
                };
                out.push(crate::authority::swept_circle::CircleAabb::new(
                    box_.0, box_.1, box_.2, box_.3,
                ));
            }
        }
        out
    }

    pub(super) fn write_building_stable_hash(&self, w: &mut StateWriter) {
        let components = self
            .runtime
            .durable
            .parcels
            .values()
            .flat_map(|p| p.build_components.values())
            .collect::<Vec<_>>();
        if components.is_empty() && self.runtime.durable.next_build_component_id <= 1 {
            return;
        }
        w.write_u64(self.runtime.durable.next_build_component_id)
            .write_u32(components.len() as u32);
        for c in components {
            write_string(w, &c.component_id);
            write_string(w, &c.owner_actor_id);
            write_string(w, &c.area_id);
            write_string(w, &c.parcel_id);
            write_string(w, &c.catalog_id);
            write_string(w, &c.kind);
            w.write_i64(i64::from(c.cell_x))
                .write_i64(i64::from(c.cell_y))
                .write_i64(i64::from(c.rotation_quarters))
                .write_bool(c.door_open);
        }
    }
}

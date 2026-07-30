//! Deterministic planar spatial index for simulation grid queries.

use std::collections::{BTreeMap, BTreeSet};

use crate::{CellAabb2, CellCoord2, EntityId, StateWriter, ZoneCell};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SpatialCategory {
    Player,
    Npc,
    Prop,
    Door,
    HarvestNode,
    CraftingStation,
    Item,
    Other(u16),
}

impl SpatialCategory {
    const fn code(self) -> u32 {
        match self {
            Self::Player => 1,
            Self::Npc => 2,
            Self::Prop => 3,
            Self::Door => 4,
            Self::HarvestNode => 5,
            Self::CraftingStation => 6,
            Self::Item => 8,
            Self::Other(v) => 10_000 + v as u32,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SpatialOccupancyKind {
    Exclusive,
    Stackable,
    Blocking,
    Interaction,
    Reservation,
    Marker,
    Other(u16),
}

impl SpatialOccupancyKind {
    const fn code(self) -> u32 {
        match self {
            Self::Exclusive => 1,
            Self::Stackable => 2,
            Self::Blocking => 3,
            Self::Interaction => 4,
            Self::Reservation => 5,
            Self::Marker => 6,
            Self::Other(v) => 10_000 + v as u32,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpatialEntry {
    pub entity: EntityId,
    pub at: ZoneCell,
    pub category: SpatialCategory,
    pub occupancy: SpatialOccupancyKind,
}

impl SpatialEntry {
    pub const fn new(
        entity: EntityId,
        at: ZoneCell,
        category: SpatialCategory,
        occupancy: SpatialOccupancyKind,
    ) -> Self {
        Self {
            entity,
            at,
            category,
            occupancy,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum AoiPriorityRing {
    SelfState,
    High,
    Nearby,
    Interactable,
    Far,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AoiRadii {
    pub high: u32,
    pub nearby: u32,
    pub interactable: u32,
    pub far: u32,
}

impl AoiRadii {
    pub const fn new(high: u32, nearby: u32, interactable: u32, far: u32) -> Self {
        Self {
            high,
            nearby,
            interactable,
            far,
        }
    }
}

impl Default for AoiRadii {
    fn default() -> Self {
        Self::new(6, 14, 20, 36)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AoiEntry {
    pub entity: EntityId,
    pub at: ZoneCell,
    pub category: SpatialCategory,
    pub ring: AoiPriorityRing,
    pub distance: u32,
}

#[derive(Debug, Clone, Default)]
pub struct SpatialIndex {
    entries: BTreeMap<EntityId, SpatialEntry>,
    entity_by_index: BTreeMap<u32, EntityId>,
    by_cell: BTreeMap<ZoneCell, BTreeSet<EntityId>>,
}

impl SpatialIndex {
    pub const fn new() -> Self {
        Self {
            entries: BTreeMap::new(),
            entity_by_index: BTreeMap::new(),
            by_cell: BTreeMap::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn insert(&mut self, entry: SpatialEntry) -> Option<SpatialEntry> {
        if let Some(existing) = self.entity_by_index.get(&entry.entity.index()) {
            if existing.generation() != entry.entity.generation() {
                return None;
            }
        }

        let previous = self.entries.insert(entry.entity, entry);
        if let Some(old) = previous {
            self.remove_from_cell(old.at, old.entity);
        }
        self.entity_by_index
            .insert(entry.entity.index(), entry.entity);
        self.by_cell
            .entry(entry.at)
            .or_default()
            .insert(entry.entity);
        previous
    }

    pub fn update(&mut self, entity: EntityId, to: ZoneCell) -> Option<SpatialEntry> {
        let mut entry = *self.entries.get(&entity)?;
        self.remove_from_cell(entry.at, entity);
        entry.at = to;
        self.entries.insert(entity, entry);
        self.by_cell.entry(to).or_default().insert(entity);
        Some(entry)
    }

    pub fn remove(&mut self, entity: EntityId) -> Option<SpatialEntry> {
        let old = self.entries.remove(&entity)?;
        self.remove_from_cell(old.at, entity);
        if self.entity_by_index.get(&entity.index()) == Some(&entity) {
            self.entity_by_index.remove(&entity.index());
        }
        Some(old)
    }

    pub fn record(&self, entity: EntityId) -> Option<&SpatialEntry> {
        self.entries.get(&entity)
    }

    pub fn records_at_cell(&self, at: ZoneCell) -> Vec<&SpatialEntry> {
        self.by_cell
            .get(&at)
            .into_iter()
            .flat_map(|set| set.iter())
            .filter_map(|entity| self.entries.get(entity))
            .collect()
    }

    pub fn entities_at_cell(&self, at: ZoneCell) -> Vec<EntityId> {
        self.by_cell
            .get(&at)
            .map(|set| set.iter().copied().collect())
            .unwrap_or_default()
    }

    pub fn first_exclusive_at_cell(&self, at: ZoneCell) -> Option<EntityId> {
        self.records_at_cell(at)
            .into_iter()
            .find(|entry| entry.occupancy == SpatialOccupancyKind::Exclusive)
            .map(|entry| entry.entity)
    }

    pub fn has_exclusive_at_cell(&self, at: ZoneCell) -> bool {
        self.first_exclusive_at_cell(at).is_some()
    }

    pub fn records_in_box(
        &self,
        zone: crate::ZoneId,
        level: crate::Level,
        area: CellAabb2,
    ) -> Vec<&SpatialEntry> {
        let area = area.normalized();
        self.entries
            .values()
            .filter(|entry| {
                entry.at.zone == zone && entry.at.level == level && area.contains(entry.at.coord)
            })
            .collect()
    }

    pub fn entities_in_box(
        &self,
        zone: crate::ZoneId,
        level: crate::Level,
        area: CellAabb2,
    ) -> Vec<EntityId> {
        self.records_in_box(zone, level, area)
            .into_iter()
            .map(|entry| entry.entity)
            .collect()
    }

    pub fn records_in_manhattan_radius(&self, center: ZoneCell, radius: u32) -> Vec<&SpatialEntry> {
        self.entries
            .values()
            .filter(|entry| {
                entry.at.zone == center.zone
                    && entry.at.level == center.level
                    && entry.at.coord.manhattan_distance(center.coord) <= radius
            })
            .collect()
    }

    pub fn entities_in_manhattan_radius(&self, center: ZoneCell, radius: u32) -> Vec<EntityId> {
        self.records_in_manhattan_radius(center, radius)
            .into_iter()
            .map(|entry| entry.entity)
            .collect()
    }

    pub fn aoi_entries_for(&self, observer: EntityId, radii: AoiRadii) -> Vec<AoiEntry> {
        let Some(observer_entry) = self.record(observer) else {
            return Vec::new();
        };
        let center = observer_entry.at;
        let scan_radius = radii
            .high
            .max(radii.nearby)
            .max(radii.interactable)
            .max(radii.far);
        let Ok(scan_radius) = i32::try_from(scan_radius) else {
            return Vec::new();
        };
        let mut entries = Vec::new();

        for dx in -scan_radius..=scan_radius {
            let remaining_y = scan_radius - dx.abs();
            for dy in -remaining_y..=remaining_y {
                let Some(x) = center.coord.x.checked_add(dx) else {
                    continue;
                };
                let Some(y) = center.coord.y.checked_add(dy) else {
                    continue;
                };
                let cell = ZoneCell::new(center.zone, center.level, CellCoord2::new(x, y));
                let Some(entity_ids) = self.by_cell.get(&cell) else {
                    continue;
                };

                for entity in entity_ids {
                    let Some(entry) = self.entries.get(entity) else {
                        continue;
                    };
                    let distance = entry.at.coord.manhattan_distance(center.coord);
                    let Some(ring) = classify_aoi_ring(observer, entry, distance, radii) else {
                        continue;
                    };
                    entries.push(AoiEntry {
                        entity: entry.entity,
                        at: entry.at,
                        category: entry.category,
                        ring,
                        distance,
                    });
                }
            }
        }
        entries.sort_by_key(|entry| (entry.ring, entry.distance, entry.entity));
        entries
    }

    pub fn records_on_cells<I>(&self, cells: I) -> Vec<&SpatialEntry>
    where
        I: IntoIterator<Item = ZoneCell>,
    {
        let mut entities = BTreeSet::new();
        for cell in cells {
            if let Some(set) = self.by_cell.get(&cell) {
                entities.extend(set.iter().copied());
            }
        }
        entities
            .iter()
            .filter_map(|entity| self.entries.get(entity))
            .collect()
    }

    pub fn entities_on_cells<I>(&self, cells: I) -> Vec<EntityId>
    where
        I: IntoIterator<Item = ZoneCell>,
    {
        self.records_on_cells(cells)
            .into_iter()
            .map(|entry| entry.entity)
            .collect()
    }

    pub fn records_along_line(&self, from: ZoneCell, to: ZoneCell) -> Vec<&SpatialEntry> {
        if from.zone != to.zone || from.level != to.level {
            return Vec::new();
        }
        self.records_on_cells(
            CellLine2::new(from.coord, to.coord)
                .map(|coord| ZoneCell::new(from.zone, from.level, coord)),
        )
    }

    pub fn entities_along_line(&self, from: ZoneCell, to: ZoneCell) -> Vec<EntityId> {
        self.records_along_line(from, to)
            .into_iter()
            .map(|entry| entry.entity)
            .collect()
    }

    pub fn stable_hash_hex(&self) -> String {
        let mut w = StateWriter::new();
        w.write_domain_header(b"spatial")
            .write_schema_version(1)
            .write_u32(u32::try_from(self.entries.len()).expect("spatial entries fit in u32"));
        for entry in self.entries.values() {
            w.write_u32(entry.entity.index())
                .write_u32(entry.entity.generation().get())
                .write_u32(entry.at.zone.0)
                .write_i64(i64::from(entry.at.level.0))
                .write_i64(i64::from(entry.at.coord.x))
                .write_i64(i64::from(entry.at.coord.y))
                .write_u32(entry.category.code())
                .write_u32(entry.occupancy.code());
        }
        w.finalize_hex()
    }

    fn remove_from_cell(&mut self, cell: ZoneCell, entity: EntityId) {
        let Some(set) = self.by_cell.get_mut(&cell) else {
            return;
        };
        set.remove(&entity);
        if set.is_empty() {
            self.by_cell.remove(&cell);
        }
    }
}

fn classify_aoi_ring(
    observer: EntityId,
    entry: &SpatialEntry,
    distance: u32,
    radii: AoiRadii,
) -> Option<AoiPriorityRing> {
    if entry.entity == observer {
        return Some(AoiPriorityRing::SelfState);
    }
    if distance <= radii.high && is_high_priority_category(entry.category) {
        return Some(AoiPriorityRing::High);
    }
    if distance <= radii.nearby && is_actor_category(entry.category) {
        return Some(AoiPriorityRing::Nearby);
    }
    if distance <= radii.interactable && is_interactable_category(entry.category) {
        return Some(AoiPriorityRing::Interactable);
    }
    if distance <= radii.far && is_actor_category(entry.category) {
        return Some(AoiPriorityRing::Far);
    }
    None
}

const fn is_high_priority_category(category: SpatialCategory) -> bool {
    matches!(category, SpatialCategory::Player | SpatialCategory::Npc)
}

const fn is_actor_category(category: SpatialCategory) -> bool {
    matches!(category, SpatialCategory::Player | SpatialCategory::Npc)
}

const fn is_interactable_category(category: SpatialCategory) -> bool {
    matches!(
        category,
        SpatialCategory::Door
            | SpatialCategory::HarvestNode
            | SpatialCategory::CraftingStation
            | SpatialCategory::Item
    )
}

#[derive(Debug, Clone)]
pub struct CellLine2 {
    current_step: i32,
    steps: i32,
    from: CellCoord2,
    dx: i32,
    dy: i32,
}

impl CellLine2 {
    pub fn new(from: CellCoord2, to: CellCoord2) -> Self {
        let dx = to.x - from.x;
        let dy = to.y - from.y;
        let steps = dx.abs().max(dy.abs());
        Self {
            current_step: 0,
            steps,
            from,
            dx,
            dy,
        }
    }
}

impl Iterator for CellLine2 {
    type Item = CellCoord2;

    fn next(&mut self) -> Option<Self::Item> {
        if self.current_step > self.steps {
            return None;
        }
        let coord = if self.steps == 0 {
            self.from
        } else {
            CellCoord2::new(
                rounded_div(
                    self.from.x * self.steps + self.dx * self.current_step,
                    self.steps,
                ),
                rounded_div(
                    self.from.y * self.steps + self.dy * self.current_step,
                    self.steps,
                ),
            )
        };
        self.current_step += 1;
        Some(coord)
    }
}

fn rounded_div(numerator: i32, denominator: i32) -> i32 {
    debug_assert!(denominator > 0);
    let half = denominator / 2;
    if numerator >= 0 {
        (numerator + half) / denominator
    } else {
        (numerator - half) / denominator
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Level, ZoneId};

    fn cell(x: i32, y: i32) -> ZoneCell {
        ZoneCell::new(ZoneId(7), Level(0), CellCoord2::new(x, y))
    }

    #[test]
    fn insert_update_remove_keeps_cell_index_current() {
        let mut index = SpatialIndex::new();
        let e = EntityId::first(1);
        index.insert(SpatialEntry::new(
            e,
            cell(1, 2),
            SpatialCategory::Npc,
            SpatialOccupancyKind::Exclusive,
        ));
        assert_eq!(index.entities_at_cell(cell(1, 2)), vec![e]);

        index.update(e, cell(3, 2));
        assert!(index.entities_at_cell(cell(1, 2)).is_empty());
        assert_eq!(index.entities_at_cell(cell(3, 2)), vec![e]);

        assert_eq!(index.remove(e).map(|entry| entry.entity), Some(e));
        assert!(index.is_empty());
    }

    #[test]
    fn stale_generation_cannot_replace_live_entity_index() {
        let mut index = SpatialIndex::new();
        let live = EntityId::first(2);
        let stale = EntityId::new(2, live.generation().next());
        index.insert(SpatialEntry::new(
            live,
            cell(0, 0),
            SpatialCategory::Player,
            SpatialOccupancyKind::Exclusive,
        ));
        assert!(index
            .insert(SpatialEntry::new(
                stale,
                cell(1, 0),
                SpatialCategory::Npc,
                SpatialOccupancyKind::Exclusive
            ))
            .is_none());
        assert_eq!(index.record(live).map(|entry| entry.at), Some(cell(0, 0)));
    }

    #[test]
    fn canonical_hash_ignores_insert_order() {
        let a = EntityId::first(1);
        let b = EntityId::first(2);
        let mut left = SpatialIndex::new();
        left.insert(SpatialEntry::new(
            a,
            cell(0, 0),
            SpatialCategory::Npc,
            SpatialOccupancyKind::Marker,
        ));
        left.insert(SpatialEntry::new(
            b,
            cell(1, 0),
            SpatialCategory::Door,
            SpatialOccupancyKind::Blocking,
        ));
        let mut right = SpatialIndex::new();
        right.insert(SpatialEntry::new(
            b,
            cell(1, 0),
            SpatialCategory::Door,
            SpatialOccupancyKind::Blocking,
        ));
        right.insert(SpatialEntry::new(
            a,
            cell(0, 0),
            SpatialCategory::Npc,
            SpatialOccupancyKind::Marker,
        ));
        assert_eq!(left.stable_hash_hex(), right.stable_hash_hex());
    }

    #[test]
    fn box_radius_and_line_queries_are_sorted_by_entity() {
        let mut index = SpatialIndex::new();
        let a = EntityId::first(1);
        let b = EntityId::first(2);
        let c = EntityId::first(3);
        index.insert(SpatialEntry::new(
            c,
            cell(5, 5),
            SpatialCategory::Prop,
            SpatialOccupancyKind::Blocking,
        ));
        index.insert(SpatialEntry::new(
            a,
            cell(0, 0),
            SpatialCategory::Player,
            SpatialOccupancyKind::Exclusive,
        ));
        index.insert(SpatialEntry::new(
            b,
            cell(2, 0),
            SpatialCategory::Npc,
            SpatialOccupancyKind::Exclusive,
        ));

        assert_eq!(
            index.entities_in_box(
                ZoneId(7),
                Level(0),
                CellAabb2::new(CellCoord2::new(0, 0), CellCoord2::new(2, 1))
            ),
            vec![a, b]
        );
        assert_eq!(
            index.entities_in_manhattan_radius(cell(0, 0), 2),
            vec![a, b]
        );
        assert_eq!(
            index.entities_along_line(cell(0, 0), cell(5, 0)),
            vec![a, b]
        );
    }

    #[test]
    fn aoi_entries_are_prioritized_and_culled() {
        let mut index = SpatialIndex::new();
        let observer = EntityId::first(1);
        let close_player = EntityId::first(2);
        let far_player = EntityId::first(3);
        let harvest = EntityId::first(4);
        let ignored_prop = EntityId::first(5);
        let too_far_npc = EntityId::first(6);
        let other_zone = EntityId::first(7);

        index.insert(SpatialEntry::new(
            observer,
            cell(10, 10),
            SpatialCategory::Player,
            SpatialOccupancyKind::Exclusive,
        ));
        index.insert(SpatialEntry::new(
            close_player,
            cell(13, 10),
            SpatialCategory::Player,
            SpatialOccupancyKind::Exclusive,
        ));
        index.insert(SpatialEntry::new(
            far_player,
            cell(21, 10),
            SpatialCategory::Player,
            SpatialOccupancyKind::Exclusive,
        ));
        index.insert(SpatialEntry::new(
            harvest,
            cell(10, 16),
            SpatialCategory::HarvestNode,
            SpatialOccupancyKind::Interaction,
        ));
        index.insert(SpatialEntry::new(
            ignored_prop,
            cell(11, 10),
            SpatialCategory::Prop,
            SpatialOccupancyKind::Marker,
        ));
        index.insert(SpatialEntry::new(
            too_far_npc,
            cell(40, 40),
            SpatialCategory::Npc,
            SpatialOccupancyKind::Exclusive,
        ));
        index.insert(SpatialEntry::new(
            other_zone,
            ZoneCell::new(ZoneId(8), Level(0), CellCoord2::new(10, 10)),
            SpatialCategory::Player,
            SpatialOccupancyKind::Exclusive,
        ));

        let entries = index.aoi_entries_for(observer, AoiRadii::new(4, 8, 8, 16));
        assert_eq!(
            entries
                .iter()
                .map(|entry| (entry.entity, entry.ring, entry.distance))
                .collect::<Vec<_>>(),
            vec![
                (observer, AoiPriorityRing::SelfState, 0),
                (close_player, AoiPriorityRing::High, 3),
                (harvest, AoiPriorityRing::Interactable, 6),
                (far_player, AoiPriorityRing::Far, 11),
            ]
        );
    }

    #[test]
    fn aoi_culls_five_hundred_players_to_visibility_budget() {
        let mut index = SpatialIndex::new();
        let observer = EntityId::first(1);
        index.insert(SpatialEntry::new(
            observer,
            cell(50, 50),
            SpatialCategory::Player,
            SpatialOccupancyKind::Exclusive,
        ));

        for n in 0..500 {
            let x = i32::try_from(n % 50).unwrap();
            let y = i32::try_from(n / 50).unwrap();
            index.insert(SpatialEntry::new(
                EntityId::first(10 + n),
                cell(x, y),
                SpatialCategory::Player,
                SpatialOccupancyKind::Exclusive,
            ));
        }

        let entries = index.aoi_entries_for(observer, AoiRadii::new(4, 10, 12, 18));
        assert_eq!(entries.first().map(|entry| entry.entity), Some(observer));
        assert!(entries.len() < 500);
        assert!(entries
            .iter()
            .all(|entry| entry.entity == observer || entry.distance <= 18));
    }
}

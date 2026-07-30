//! Deterministic item containers and stock reservations for early Successor slices.
//!
//! This is a small port of Strata's useful logistics shape, not the full colony hauling
//! system. Successor needs stable stock, reservation, transfer, and hash behavior now;
//! labor planning can stay outside this crate until it has real gameplay pressure.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use successor_core::{StateWriter, TickIndex};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ItemId(pub u32);

pub const RESOURCE_STACK_CAP: u32 = 100_000;

pub const fn is_resource_item_id(item: ItemId) -> bool {
    matches!(
        item.0,
        2_001 | 2_002 | 2_003 | 2_004 | 2_005 | 2_006 | 2_101 | 2_102 | 2_103 | 2_104
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ItemVariantId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ContainerId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StackId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StockReservationId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct InventoryActorId(pub u32);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StockFlags {
    pub tracked_quality: bool,
    pub quest_bound: bool,
}

impl StockFlags {
    fn canonical_bits(self) -> u32 {
        (if self.tracked_quality { 1 } else { 0 }) | ((if self.quest_bound { 1 } else { 0 }) << 1)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StockKey {
    pub item: ItemId,
    pub variant: ItemVariantId,
    pub flags: StockFlags,
}

impl StockKey {
    pub const fn new(item: ItemId, variant: ItemVariantId) -> Self {
        Self {
            item,
            variant,
            flags: StockFlags {
                tracked_quality: false,
                quest_bound: false,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StockStack {
    pub id: StackId,
    pub key: StockKey,
    pub quantity: u32,
    pub reserved: u32,
}

impl StockStack {
    pub fn available_quantity(&self) -> u32 {
        self.quantity.saturating_sub(self.reserved)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerStock {
    pub id: ContainerId,
    pub label: String,
    pub stacks: BTreeMap<StockKey, StockStack>,
}

impl ContainerStock {
    pub fn new(id: ContainerId, label: impl Into<String>) -> Self {
        Self {
            id,
            label: label.into(),
            stacks: BTreeMap::new(),
        }
    }

    pub fn available_quantity(&self, key: StockKey) -> u32 {
        self.stacks
            .get(&key)
            .map(StockStack::available_quantity)
            .unwrap_or_default()
    }

    pub fn total_quantity(&self, key: StockKey) -> u32 {
        self.stacks
            .get(&key)
            .map(|stack| stack.quantity)
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ReservationPurpose {
    Hold,
    Transfer,
    Consume,
    Craft,
    Move,
    Other(u16),
}

impl ReservationPurpose {
    const fn code(self) -> u32 {
        match self {
            Self::Hold => 1,
            Self::Transfer => 2,
            Self::Consume => 3,
            Self::Craft => 4,
            Self::Move => 5,
            Self::Other(v) => 10_000 + v as u32,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StockReservation {
    pub id: StockReservationId,
    pub container: ContainerId,
    pub key: StockKey,
    pub quantity: u32,
    pub actor: InventoryActorId,
    pub purpose: ReservationPurpose,
    pub expires_at: Option<TickIndex>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransferReport {
    pub reservation: StockReservationId,
    pub source: ContainerId,
    pub destination: ContainerId,
    pub key: StockKey,
    pub quantity: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConsumptionReport {
    pub reservation: StockReservationId,
    pub source: ContainerId,
    pub key: StockKey,
    pub quantity: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReservationRetentionReport {
    pub expired: Vec<StockReservationId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InventorySummary {
    pub container_count: u32,
    pub reservation_count: u32,
    pub total_quantity: u32,
    pub reserved_quantity: u32,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum InventoryError {
    #[error("container {0:?} does not exist")]
    MissingContainer(ContainerId),
    #[error("reservation {0:?} does not exist")]
    MissingReservation(StockReservationId),
    #[error("container {container:?} has no stack for {key:?}")]
    MissingStack {
        container: ContainerId,
        key: StockKey,
    },
    #[error("requested {requested} units from container {container:?}, but only {available} are available")]
    InsufficientAvailable {
        container: ContainerId,
        key: StockKey,
        requested: u32,
        available: u32,
    },
    #[error("stack cap {cap} exceeded for {key:?} in container {container:?}; requested final quantity {requested}")]
    StackCapacityExceeded {
        container: ContainerId,
        key: StockKey,
        requested: u32,
        cap: u32,
    },
    #[error("quantity must be greater than zero")]
    ZeroQuantity,
}

#[derive(Debug, Clone, Default)]
pub struct InventoryState {
    containers: BTreeMap<ContainerId, ContainerStock>,
    reservations: BTreeMap<StockReservationId, StockReservation>,
    next_reservation_id: u32,
}

impl InventoryState {
    pub const fn new() -> Self {
        Self {
            containers: BTreeMap::new(),
            reservations: BTreeMap::new(),
            next_reservation_id: 1,
        }
    }

    pub fn add_container(
        &mut self,
        id: ContainerId,
        label: impl Into<String>,
    ) -> Option<ContainerStock> {
        self.containers.insert(id, ContainerStock::new(id, label))
    }

    pub fn container(&self, id: ContainerId) -> Option<&ContainerStock> {
        self.containers.get(&id)
    }

    pub fn reservations(&self) -> &BTreeMap<StockReservationId, StockReservation> {
        &self.reservations
    }

    pub fn put_stock(
        &mut self,
        container: ContainerId,
        key: StockKey,
        quantity: u32,
    ) -> Result<StackId, InventoryError> {
        if quantity == 0 {
            return Err(InventoryError::ZeroQuantity);
        }
        self.ensure_can_put_stock(container, key, quantity)?;
        let stock = self
            .containers
            .get_mut(&container)
            .expect("container exists after capacity check");
        let id = stack_id_for_key(container, key);
        stock
            .stacks
            .entry(key)
            .and_modify(|stack| stack.quantity = stack.quantity.saturating_add(quantity))
            .or_insert(StockStack {
                id,
                key,
                quantity,
                reserved: 0,
            });
        Ok(id)
    }

    pub fn available_quantity(
        &self,
        container: ContainerId,
        key: StockKey,
    ) -> Result<u32, InventoryError> {
        Ok(self
            .containers
            .get(&container)
            .ok_or(InventoryError::MissingContainer(container))?
            .available_quantity(key))
    }

    pub fn reserve_stock(
        &mut self,
        container: ContainerId,
        key: StockKey,
        quantity: u32,
        actor: InventoryActorId,
        purpose: ReservationPurpose,
        expires_at: Option<TickIndex>,
    ) -> Result<StockReservationId, InventoryError> {
        if quantity == 0 {
            return Err(InventoryError::ZeroQuantity);
        }
        let available = self.available_quantity(container, key)?;
        if available < quantity {
            return Err(InventoryError::InsufficientAvailable {
                container,
                key,
                requested: quantity,
                available,
            });
        }

        let id = StockReservationId(self.next_reservation_id);
        self.next_reservation_id = self.next_reservation_id.wrapping_add(1);
        let stack = self.stack_mut(container, key)?;
        stack.reserved = stack.reserved.saturating_add(quantity);
        self.reservations.insert(
            id,
            StockReservation {
                id,
                container,
                key,
                quantity,
                actor,
                purpose,
                expires_at,
            },
        );
        Ok(id)
    }

    pub fn release_reservation(
        &mut self,
        id: StockReservationId,
    ) -> Result<StockReservation, InventoryError> {
        let reservation = self
            .reservations
            .remove(&id)
            .ok_or(InventoryError::MissingReservation(id))?;
        if let Some(stack) = self
            .containers
            .get_mut(&reservation.container)
            .and_then(|container| container.stacks.get_mut(&reservation.key))
        {
            stack.reserved = stack.reserved.saturating_sub(reservation.quantity);
        }
        Ok(reservation)
    }

    pub fn transfer_reserved(
        &mut self,
        id: StockReservationId,
        destination: ContainerId,
    ) -> Result<TransferReport, InventoryError> {
        if !self.containers.contains_key(&destination) {
            return Err(InventoryError::MissingContainer(destination));
        }
        let reservation = *self
            .reservations
            .get(&id)
            .ok_or(InventoryError::MissingReservation(id))?;
        self.ensure_can_put_stock(destination, reservation.key, reservation.quantity)?;
        self.debit_reserved(reservation)?;
        self.reservations.remove(&id);
        self.put_stock(destination, reservation.key, reservation.quantity)?;
        Ok(TransferReport {
            reservation: id,
            source: reservation.container,
            destination,
            key: reservation.key,
            quantity: reservation.quantity,
        })
    }

    pub fn consume_reserved(
        &mut self,
        id: StockReservationId,
    ) -> Result<ConsumptionReport, InventoryError> {
        let reservation = *self
            .reservations
            .get(&id)
            .ok_or(InventoryError::MissingReservation(id))?;
        self.debit_reserved(reservation)?;
        self.reservations.remove(&id);
        Ok(ConsumptionReport {
            reservation: id,
            source: reservation.container,
            key: reservation.key,
            quantity: reservation.quantity,
        })
    }

    pub fn transfer_unreserved(
        &mut self,
        source: ContainerId,
        destination: ContainerId,
        key: StockKey,
        quantity: u32,
    ) -> Result<(), InventoryError> {
        if quantity == 0 {
            return Err(InventoryError::ZeroQuantity);
        }
        if !self.containers.contains_key(&destination) {
            return Err(InventoryError::MissingContainer(destination));
        }
        let available = self.available_quantity(source, key)?;
        if available < quantity {
            return Err(InventoryError::InsufficientAvailable {
                container: source,
                key,
                requested: quantity,
                available,
            });
        }
        self.ensure_can_put_stock(destination, key, quantity)?;
        self.debit_unreserved(source, key, quantity)?;
        self.put_stock(destination, key, quantity)?;
        Ok(())
    }

    pub fn consume_unreserved(
        &mut self,
        source: ContainerId,
        key: StockKey,
        quantity: u32,
    ) -> Result<(), InventoryError> {
        if quantity == 0 {
            return Err(InventoryError::ZeroQuantity);
        }
        let available = self.available_quantity(source, key)?;
        if available < quantity {
            return Err(InventoryError::InsufficientAvailable {
                container: source,
                key,
                requested: quantity,
                available,
            });
        }
        self.debit_unreserved(source, key, quantity)
    }

    pub fn expire_reservations(&mut self, tick: TickIndex) -> ReservationRetentionReport {
        let expired: Vec<_> = self
            .reservations
            .values()
            .filter(|reservation| {
                reservation
                    .expires_at
                    .is_some_and(|expires| expires <= tick)
            })
            .map(|reservation| reservation.id)
            .collect();
        for id in &expired {
            let _ = self.release_reservation(*id);
        }
        ReservationRetentionReport { expired }
    }

    pub fn summary(&self) -> InventorySummary {
        let mut total_quantity = 0u32;
        let mut reserved_quantity = 0u32;
        for container in self.containers.values() {
            for stack in container.stacks.values() {
                total_quantity = total_quantity.saturating_add(stack.quantity);
                reserved_quantity = reserved_quantity.saturating_add(stack.reserved);
            }
        }
        InventorySummary {
            container_count: u32::try_from(self.containers.len())
                .expect("container count fits in u32"),
            reservation_count: u32::try_from(self.reservations.len())
                .expect("reservation count fits in u32"),
            total_quantity,
            reserved_quantity,
        }
    }

    pub fn stable_hash_hex(&self) -> String {
        let mut w = StateWriter::new();
        w.write_domain_header(b"inventory")
            .write_schema_version(1)
            .write_u32(self.next_reservation_id)
            .write_u32(u32::try_from(self.containers.len()).expect("container count fits in u32"));
        for container in self.containers.values() {
            w.write_u32(container.id.0)
                .write_u32(
                    u32::try_from(container.label.len())
                        .expect("container label length fits in u32"),
                )
                .write_bytes(container.label.as_bytes())
                .write_u32(u32::try_from(container.stacks.len()).expect("stack count fits in u32"));
            for (key, stack) in &container.stacks {
                write_key(&mut w, *key);
                w.write_u64(stack.id.0)
                    .write_u32(stack.quantity)
                    .write_u32(stack.reserved);
            }
        }
        w.write_u32(u32::try_from(self.reservations.len()).expect("reservation count fits in u32"));
        for reservation in self.reservations.values() {
            w.write_u32(reservation.id.0)
                .write_u32(reservation.container.0);
            write_key(&mut w, reservation.key);
            w.write_u32(reservation.quantity)
                .write_u32(reservation.actor.0)
                .write_u32(reservation.purpose.code());
            match reservation.expires_at {
                Some(tick) => {
                    w.write_bool(true).write_u64(tick.0);
                }
                None => {
                    w.write_bool(false);
                }
            }
        }
        w.finalize_hex()
    }

    fn ensure_can_put_stock(
        &self,
        container: ContainerId,
        key: StockKey,
        quantity: u32,
    ) -> Result<(), InventoryError> {
        let stock = self
            .containers
            .get(&container)
            .ok_or(InventoryError::MissingContainer(container))?;
        if is_resource_item_id(key.item) {
            let requested = stock.total_quantity(key).saturating_add(quantity);
            if requested > RESOURCE_STACK_CAP {
                return Err(InventoryError::StackCapacityExceeded {
                    container,
                    key,
                    requested,
                    cap: RESOURCE_STACK_CAP,
                });
            }
        }
        Ok(())
    }

    fn stack_mut(
        &mut self,
        container: ContainerId,
        key: StockKey,
    ) -> Result<&mut StockStack, InventoryError> {
        self.containers
            .get_mut(&container)
            .ok_or(InventoryError::MissingContainer(container))?
            .stacks
            .get_mut(&key)
            .ok_or(InventoryError::MissingStack { container, key })
    }

    fn debit_reserved(&mut self, reservation: StockReservation) -> Result<(), InventoryError> {
        let stack = self.stack_mut(reservation.container, reservation.key)?;
        if stack.quantity < reservation.quantity || stack.reserved < reservation.quantity {
            return Err(InventoryError::InsufficientAvailable {
                container: reservation.container,
                key: reservation.key,
                requested: reservation.quantity,
                available: stack.available_quantity(),
            });
        }
        stack.quantity -= reservation.quantity;
        stack.reserved -= reservation.quantity;
        Ok(())
    }

    fn debit_unreserved(
        &mut self,
        container: ContainerId,
        key: StockKey,
        quantity: u32,
    ) -> Result<(), InventoryError> {
        let stack = self.stack_mut(container, key)?;
        stack.quantity -= quantity;
        Ok(())
    }
}

pub fn stack_id_for_key(container: ContainerId, key: StockKey) -> StackId {
    let mut w = StateWriter::new();
    w.write_domain_header(b"inventory-stack")
        .write_schema_version(1)
        .write_u32(container.0);
    write_key(&mut w, key);
    let hash = w.finalize();
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&hash[..8]);
    StackId(u64::from_le_bytes(bytes))
}

fn write_key(w: &mut StateWriter, key: StockKey) {
    w.write_u32(key.item.0)
        .write_u32(key.variant.0)
        .write_u32(key.flags.canonical_bits());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (InventoryState, StockKey) {
        let mut inventory = InventoryState::new();
        inventory.add_container(ContainerId(1), "observer");
        inventory.add_container(ContainerId(2), "stash");
        let scrap = StockKey::new(ItemId(10), ItemVariantId(0));
        inventory.put_stock(ContainerId(1), scrap, 5).unwrap();
        (inventory, scrap)
    }

    #[test]
    fn resource_stock_rejects_stack_cap_overflow() {
        let mut inventory = InventoryState::new();
        inventory.add_container(ContainerId(1), "resource crate");
        let iron = StockKey::new(ItemId(2_001), ItemVariantId(7));
        inventory
            .put_stock(ContainerId(1), iron, RESOURCE_STACK_CAP)
            .unwrap();

        assert_eq!(
            inventory.put_stock(ContainerId(1), iron, 1),
            Err(InventoryError::StackCapacityExceeded {
                container: ContainerId(1),
                key: iron,
                requested: RESOURCE_STACK_CAP.saturating_add(1),
                cap: RESOURCE_STACK_CAP,
            })
        );
        assert_eq!(
            inventory
                .container(ContainerId(1))
                .unwrap()
                .total_quantity(iron),
            RESOURCE_STACK_CAP
        );
    }

    #[test]
    fn resource_transfer_rejects_destination_stack_cap_without_debiting_source() {
        let mut inventory = InventoryState::new();
        inventory.add_container(ContainerId(1), "source");
        inventory.add_container(ContainerId(2), "destination");
        let iron = StockKey::new(ItemId(2_001), ItemVariantId(7));
        inventory.put_stock(ContainerId(1), iron, 2).unwrap();
        inventory
            .put_stock(ContainerId(2), iron, RESOURCE_STACK_CAP - 1)
            .unwrap();

        assert_eq!(
            inventory.transfer_unreserved(ContainerId(1), ContainerId(2), iron, 2),
            Err(InventoryError::StackCapacityExceeded {
                container: ContainerId(2),
                key: iron,
                requested: RESOURCE_STACK_CAP.saturating_add(1),
                cap: RESOURCE_STACK_CAP,
            })
        );
        assert_eq!(
            inventory
                .container(ContainerId(1))
                .unwrap()
                .total_quantity(iron),
            2
        );
        assert_eq!(
            inventory
                .container(ContainerId(2))
                .unwrap()
                .total_quantity(iron),
            RESOURCE_STACK_CAP - 1
        );
    }

    #[test]
    fn non_resource_stock_keeps_existing_merge_behavior() {
        let mut inventory = InventoryState::new();
        inventory.add_container(ContainerId(1), "observer");
        let scrap = StockKey::new(ItemId(10), ItemVariantId(0));

        inventory
            .put_stock(ContainerId(1), scrap, RESOURCE_STACK_CAP)
            .unwrap();
        inventory.put_stock(ContainerId(1), scrap, 5).unwrap();

        assert_eq!(
            inventory
                .container(ContainerId(1))
                .unwrap()
                .total_quantity(scrap),
            RESOURCE_STACK_CAP.saturating_add(5)
        );
    }

    #[test]
    fn reserve_stock_withholds_available_quantity() {
        let (mut inventory, scrap) = setup();
        let id = inventory
            .reserve_stock(
                ContainerId(1),
                scrap,
                3,
                InventoryActorId(9),
                ReservationPurpose::Craft,
                None,
            )
            .unwrap();
        assert_eq!(id, StockReservationId(1));
        assert_eq!(
            inventory.available_quantity(ContainerId(1), scrap).unwrap(),
            2
        );
        assert_eq!(inventory.summary().reserved_quantity, 3);
    }

    #[test]
    fn consume_reserved_removes_stock_and_reservation() {
        let (mut inventory, scrap) = setup();
        let id = inventory
            .reserve_stock(
                ContainerId(1),
                scrap,
                2,
                InventoryActorId(9),
                ReservationPurpose::Consume,
                None,
            )
            .unwrap();
        let report = inventory.consume_reserved(id).unwrap();
        assert_eq!(report.quantity, 2);
        assert_eq!(
            inventory
                .container(ContainerId(1))
                .unwrap()
                .total_quantity(scrap),
            3
        );
        assert!(inventory.reservations().is_empty());
    }

    #[test]
    fn transfer_reserved_moves_to_destination() {
        let (mut inventory, scrap) = setup();
        let id = inventory
            .reserve_stock(
                ContainerId(1),
                scrap,
                4,
                InventoryActorId(9),
                ReservationPurpose::Transfer,
                None,
            )
            .unwrap();
        inventory.transfer_reserved(id, ContainerId(2)).unwrap();
        assert_eq!(
            inventory
                .container(ContainerId(1))
                .unwrap()
                .total_quantity(scrap),
            1
        );
        assert_eq!(
            inventory
                .container(ContainerId(2))
                .unwrap()
                .total_quantity(scrap),
            4
        );
        assert!(inventory.reservations().is_empty());
    }

    #[test]
    fn expired_reservations_release_stock() {
        let (mut inventory, scrap) = setup();
        let id = inventory
            .reserve_stock(
                ContainerId(1),
                scrap,
                2,
                InventoryActorId(9),
                ReservationPurpose::Hold,
                Some(TickIndex(3)),
            )
            .unwrap();
        let report = inventory.expire_reservations(TickIndex(3));
        assert_eq!(report.expired, vec![id]);
        assert_eq!(
            inventory.available_quantity(ContainerId(1), scrap).unwrap(),
            5
        );
    }

    #[test]
    fn stable_hash_ignores_container_insert_order() {
        let scrap = StockKey::new(ItemId(10), ItemVariantId(0));

        let mut left = InventoryState::new();
        left.add_container(ContainerId(1), "observer");
        left.add_container(ContainerId(2), "stash");
        left.put_stock(ContainerId(1), scrap, 5).unwrap();

        let mut right = InventoryState::new();
        right.add_container(ContainerId(2), "stash");
        right.add_container(ContainerId(1), "observer");
        right.put_stock(ContainerId(1), scrap, 5).unwrap();

        assert_eq!(left.stable_hash_hex(), right.stable_hash_hex());
    }
}

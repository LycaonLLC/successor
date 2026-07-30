use super::*;

const BANK_SLOT_CAPACITY: usize = 100;
const SKILL_BACKUP_COST: u64 = 1_000;
const PLAYER_CORPSE_LIFETIME_MINUTES: u64 = 120;
// Stable starter/clone equipment ids. 7_319 is the authored canvas boot item.
// The underlayer is authority-owned because it is a baseline wearable, not loot.
pub(super) const STARTER_BODYSUIT_ITEM_ID: u32 = 9_900_001;
const STARTER_BOOTS_ITEM_ID: u32 = 7_319;
const STARTER_BODYSUIT_COLOR: &str = "#89cff0";
const STARTER_BOOTS_COLORS: [&str; 2] = ["#303030", "#808080"];
pub(super) const TERMINAL_INTERACTION_RADIUS_MILLI_CELLS: i32 = 1_750;

pub(super) fn is_fixed_player_clothing_item_id(item_id: u32) -> bool {
    matches!(item_id, STARTER_BODYSUIT_ITEM_ID | STARTER_BOOTS_ITEM_ID)
}

fn prop_cell(prop: &PropSnapshot) -> Option<AuthorityCell> {
    Some(AuthorityCell::new(
        prop.cell.x.as_i64()?.try_into().ok()?,
        prop.cell.y.as_i64()?.try_into().ok()?,
    ))
}

pub(super) fn terminals_from_props(props: &[PropSnapshot]) -> Vec<AuthorityTerminalState> {
    props
        .iter()
        .filter_map(|prop| {
            let kind = match prop.kind.as_str() {
                "bank_terminal" | "clone_terminal" | "trade_terminal" | "pa_terminal"
                | "factory" => prop.kind.clone(),
                _ if prop.id.contains("bank-terminal") => "bank_terminal".to_owned(),
                _ if prop.id.contains("clone-terminal") => "clone_terminal".to_owned(),
                _ if prop.id.contains("trade-terminal") => "trade_terminal".to_owned(),
                _ if prop.id.contains("pa-terminal") || prop.id.contains("pa_terminal") => {
                    "pa_terminal".to_owned()
                }
                _ if prop.id == "dustgate-occupation-workbench"
                    || prop.id.contains("-factory")
                    || (prop.id.contains("workbench") && prop.interactive) =>
                {
                    "factory".to_owned()
                }
                _ => return None,
            };
            Some(AuthorityTerminalState {
                id: prop.id.clone(),
                kind,
                area_id: prop.area_id.clone(),
                cell: prop_cell(prop)?,
            })
        })
        .collect()
}

impl SliceAuthorityState {
    pub(crate) fn bank_snapshot_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Option<AuthorityBankSnapshot> {
        let actor = self.runtime.durable.actors.get(&config.player_actor_id)?;
        let account = self.runtime.durable.bank_accounts.get(&actor.id);
        let backup = account.and_then(|account| account.skill_backup.as_ref());
        Some(AuthorityBankSnapshot {
            actor_id: actor.id.clone(),
            bank_credits: account.map_or(0, |account| account.bank_credits),
            items: self
                .runtime
                .durable
                .inventory
                .iter()
                .filter(|row| row.container == format!("bank:{}", actor.id))
                .cloned()
                .collect(),
            backup_present: backup.is_some(),
            backup_saved_tick: backup.map(|backup| backup.saved_tick),
            backup_skill_count: backup.map_or(0, |backup| backup.skill_boxes.len() as u32),
            backup_cost: SKILL_BACKUP_COST,
        })
    }

    fn actor_near_terminal(&self, actor: &ActorAuthorityState, kind: &str) -> bool {
        self.runtime.durable.world.terminals.iter().any(|terminal| {
            terminal.kind == kind
                && terminal.area_id == actor.area_id
                && position_distance_milli(
                    actor.position,
                    AuthorityPosition::from_cell(terminal.cell),
                ) <= TERMINAL_INTERACTION_RADIUS_MILLI_CELLS
        })
    }

    fn require_bank_actor(
        &self,
        actor_id: &str,
    ) -> Result<ActorAuthorityState, AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        if !self.actor_near_terminal(actor, "bank_terminal") {
            return Err(AuthorityRejectReason::NotAtBankTerminal);
        }
        Ok(actor.clone())
    }

    pub(super) fn apply_bank_store_item(
        &mut self,
        config: &SliceAuthorityConfig,
        source_stack_id: &str,
        quantity: u32,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.require_bank_actor(&config.player_actor_id)?;
        if quantity == 0 {
            return Err(AuthorityRejectReason::InvalidBankQuantity);
        }
        let source_index = self.runtime.durable.inventory.iter().position(|row| {
            actor_owns_inventory_container(&actor.id, &row.container)
                && row.stack_id.to_string() == source_stack_id
        });
        let source_index = source_index.ok_or(AuthorityRejectReason::BankStackMissing)?;
        let source = self.runtime.durable.inventory[source_index].clone();
        if is_fixed_player_clothing_item_id(source.item_id) {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        if actor.equipped_weapon_item_id != 0
            && actor.equipped_weapon_item_id == source.item_id
            && actor.equipped_weapon_variant_id == source.variant_id
        {
            return Err(AuthorityRejectReason::BankStackMissing);
        }
        if source.available < quantity {
            return Err(AuthorityRejectReason::InvalidBankQuantity);
        }
        let bank_container = format!("bank:{}", actor.id);
        let matching = self.runtime.durable.inventory.iter().position(|row| {
            row.container == bank_container
                && row.item_id == source.item_id
                && row.variant_id == source.variant_id
                && row.item == source.item
        });
        if matching.is_none()
            && self
                .runtime
                .durable
                .inventory
                .iter()
                .filter(|row| row.container == bank_container && row.quantity > 0)
                .count()
                >= BANK_SLOT_CAPACITY
        {
            return Err(AuthorityRejectReason::BankCapacity);
        }
        self.runtime.durable.inventory[source_index].quantity =
            source.quantity.saturating_sub(quantity);
        self.runtime.durable.inventory[source_index].available =
            source.available.saturating_sub(quantity);
        self.runtime.durable.inventory[source_index].reserved = source
            .reserved
            .min(self.runtime.durable.inventory[source_index].quantity);
        let bank_index = matching.unwrap_or_else(|| {
            let stack_id = self.next_inventory_stack_id(&bank_container);
            self.runtime.durable.inventory.push(InventoryStackSnapshot {
                stack_id,
                container: bank_container.clone(),
                item: source.item.clone(),
                item_id: source.item_id,
                variant_id: source.variant_id,
                quantity: 0,
                reserved: 0,
                available: 0,
            });
            self.runtime.durable.inventory.len() - 1
        });
        self.runtime.durable.inventory[bank_index].quantity = self.runtime.durable.inventory
            [bank_index]
            .quantity
            .saturating_add(quantity);
        self.runtime.durable.inventory[bank_index].available =
            self.runtime.durable.inventory[bank_index].quantity;
        self.prune_empty_inventory_rows();
        Ok(())
    }

    pub(super) fn apply_bank_retrieve_item(
        &mut self,
        config: &SliceAuthorityConfig,
        bank_stack_id: &str,
        quantity: u32,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.require_bank_actor(&config.player_actor_id)?;
        if quantity == 0 {
            return Err(AuthorityRejectReason::InvalidBankQuantity);
        }
        let bank_container = format!("bank:{}", actor.id);
        let index = self
            .runtime
            .durable
            .inventory
            .iter()
            .position(|row| {
                row.container == bank_container && row.stack_id.to_string() == bank_stack_id
            })
            .ok_or(AuthorityRejectReason::BankStackMissing)?;
        let source = self.runtime.durable.inventory[index].clone();
        if source.available < quantity {
            return Err(AuthorityRejectReason::InvalidBankQuantity);
        }
        let added = self.add_actor_named_inventory_stack(
            &actor.id,
            source.item_id,
            source.variant_id,
            &source.item,
            quantity,
            u32::MAX,
            "field-pack",
        );
        if added != quantity {
            return Err(AuthorityRejectReason::ContainerFull);
        }
        self.runtime.durable.inventory[index].quantity = source.quantity.saturating_sub(quantity);
        self.runtime.durable.inventory[index].available = source.available.saturating_sub(quantity);
        self.runtime.durable.inventory[index].reserved = 0;
        self.prune_empty_inventory_rows();
        Ok(())
    }

    pub(super) fn apply_bank_deposit_credits(
        &mut self,
        config: &SliceAuthorityConfig,
        amount: u64,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.require_bank_actor(&config.player_actor_id)?;
        if amount == 0 {
            return Err(AuthorityRejectReason::InvalidBankQuantity);
        }
        let bank_total = self
            .runtime
            .durable
            .bank_accounts
            .get(&actor.id)
            .map(|bank| bank.bank_credits)
            .unwrap_or_default()
            .checked_add(amount)
            .ok_or(AuthorityRejectReason::BankOverflow)?;
        let wallet = actor
            .professions
            .credits
            .checked_sub(amount)
            .ok_or(AuthorityRejectReason::InsufficientCredits)?;
        let bank = self
            .runtime
            .durable
            .bank_accounts
            .entry(actor.id.clone())
            .or_default();
        bank.bank_credits = bank_total;
        self.runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .expect("actor checked")
            .professions
            .credits = wallet;
        Ok(())
    }

    pub(super) fn apply_bank_withdraw_credits(
        &mut self,
        config: &SliceAuthorityConfig,
        amount: u64,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.require_bank_actor(&config.player_actor_id)?;
        if amount == 0 {
            return Err(AuthorityRejectReason::InvalidBankQuantity);
        }
        let bank_total = self
            .runtime
            .durable
            .bank_accounts
            .get(&actor.id)
            .map(|bank| bank.bank_credits)
            .unwrap_or_default()
            .checked_sub(amount)
            .ok_or(AuthorityRejectReason::InsufficientCredits)?;
        let wallet = actor
            .professions
            .credits
            .checked_add(amount)
            .ok_or(AuthorityRejectReason::BankOverflow)?;
        let bank = self
            .runtime
            .durable
            .bank_accounts
            .entry(actor.id.clone())
            .or_default();
        bank.bank_credits = bank_total;
        self.runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .expect("actor checked")
            .professions
            .credits = wallet;
        Ok(())
    }

    pub(super) fn ensure_initial_skill_backup(&mut self, actor_id: &str) {
        let Some(actor) = self.runtime.durable.actors.get(actor_id) else {
            return;
        };
        if !is_player_like_role(&actor.role) {
            return;
        }
        let account = self
            .runtime
            .durable
            .bank_accounts
            .entry(actor_id.to_owned())
            .or_default();
        if account.skill_backup.is_none() {
            account.skill_backup = Some(SkillBackupAuthorityState {
                learned: actor.professions.learned.clone(),
                xp: actor.professions.xp.clone(),
                track_xp: actor.professions.track_xp.clone(),
                skill_boxes: actor.professions.skill_boxes.clone(),
                active_title_id: actor.professions.active_title_id.clone(),
                skill_point_cap: actor.professions.skill_point_cap,
                saved_tick: self.runtime.durable.tick,
            });
        }
    }

    pub(super) fn apply_clone_save_skill_backup(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        if !self.actor_near_terminal(&actor, "clone_terminal") {
            return Err(AuthorityRejectReason::NotAtBankTerminal);
        }
        self.ensure_initial_skill_backup(&actor.id);
        let account = self
            .runtime
            .durable
            .bank_accounts
            .entry(actor.id.clone())
            .or_default();
        let mut remaining = SKILL_BACKUP_COST;
        let bank_spend = account.bank_credits.min(remaining);
        account.bank_credits -= bank_spend;
        remaining -= bank_spend;
        if remaining > 0 {
            let wallet = self
                .runtime
                .durable
                .actors
                .get(&actor.id)
                .expect("actor checked")
                .professions
                .credits;
            if wallet < remaining {
                account.bank_credits = account.bank_credits.saturating_add(bank_spend);
                return Err(AuthorityRejectReason::InsufficientCredits);
            }
            self.runtime
                .durable
                .actors
                .get_mut(&actor.id)
                .expect("actor checked")
                .professions
                .credits -= remaining;
        }
        account.skill_backup = Some(SkillBackupAuthorityState {
            learned: actor.professions.learned,
            xp: actor.professions.xp,
            track_xp: actor.professions.track_xp,
            skill_boxes: actor.professions.skill_boxes,
            active_title_id: actor.professions.active_title_id,
            skill_point_cap: actor.professions.skill_point_cap,
            saved_tick: self.runtime.durable.tick,
        });
        Ok(())
    }

    fn player_corpse_snapshot(
        &self,
        corpse: &PlayerCorpseState,
        observer_actor_id: Option<&str>,
    ) -> AuthorityPlayerCorpseSnapshot {
        AuthorityPlayerCorpseSnapshot {
            id: corpse.id.clone(),
            owner_actor_id: corpse.owner_actor_id.clone(),
            owner_label: corpse.owner_label.clone(),
            area_id: corpse.area_id.clone(),
            cell: corpse.cell,
            position: corpse.position,
            expiry_tick: corpse.expiry_tick,
            has_items: self
                .runtime
                .durable
                .inventory
                .iter()
                .any(|row| row.container == corpse.container && row.available > 0),
            credits_present: corpse.credits > 0,
            credits_count: corpse.credits,
            is_owner: observer_actor_id == Some(corpse.owner_actor_id.as_str()),
            container: corpse.container.clone(),
        }
    }

    pub(crate) fn all_player_corpse_snapshots(&self) -> Vec<AuthorityPlayerCorpseSnapshot> {
        self.runtime
            .durable
            .player_corpses
            .values()
            .filter(|corpse| corpse.expiry_tick > self.runtime.durable.tick)
            .map(|corpse| self.player_corpse_snapshot(corpse, None))
            .collect()
    }

    pub(crate) fn corpse_snapshots_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Vec<AuthorityPlayerCorpseSnapshot> {
        let Some(observer) = self.runtime.durable.actors.get(&config.player_actor_id) else {
            return Vec::new();
        };
        let radius_squared = i64::from(config.area_interest_radius_cells).pow(2);
        self.runtime
            .durable
            .player_corpses
            .values()
            .filter(|corpse| {
                if corpse.expiry_tick <= self.runtime.durable.tick
                    || corpse.area_id != observer.area_id
                {
                    return false;
                }
                let dx = i64::from(corpse.cell.x - observer.cell.x);
                let dy = i64::from(corpse.cell.y - observer.cell.y);
                dx * dx + dy * dy <= radius_squared
            })
            .map(|corpse| self.player_corpse_snapshot(corpse, Some(observer.id.as_str())))
            .collect()
    }

    pub(super) fn expire_player_corpses(&mut self) {
        let expired = self
            .runtime
            .durable
            .player_corpses
            .values()
            .filter(|c| c.expiry_tick <= self.runtime.durable.tick)
            .map(|c| c.id.clone())
            .collect::<Vec<_>>();
        for id in expired {
            if let Some(corpse) = self.runtime.durable.player_corpses.remove(&id) {
                self.runtime
                    .durable
                    .inventory
                    .retain(|r| r.container != corpse.container);
            }
        }
    }

    fn create_player_corpse(&mut self, actor_id: &str) {
        let Some(actor) = self.runtime.durable.actors.get(actor_id).cloned() else {
            return;
        };
        let id = format!(
            "player-corpse:{}",
            self.runtime.durable.next_player_corpse_id
        );
        self.runtime.durable.next_player_corpse_id =
            self.runtime.durable.next_player_corpse_id.saturating_add(1);
        let container = format!("corpse:{id}");
        for row in self.runtime.durable.inventory.iter_mut().filter(|row| {
            actor_owns_inventory_container(actor_id, &row.container)
                && !is_fixed_player_clothing_item_id(row.item_id)
        }) {
            row.container = container.clone();
            row.reserved = 0;
            row.available = row.quantity;
        }
        self.runtime
            .durable
            .reservations
            .retain(|r| r.actor != actor_id && !actor_owns_inventory_container(actor_id, &r.from));
        let credits = actor.professions.credits;
        self.runtime
            .durable
            .actors
            .get_mut(actor_id)
            .expect("actor checked")
            .professions
            .credits = 0;
        let expiry = self.runtime.durable.tick.saturating_add(
            PLAYER_CORPSE_LIFETIME_MINUTES
                .saturating_mul(60)
                .saturating_mul(u64::from(self.runtime.durable.world.tick_rate_hz.max(1))),
        );
        self.runtime.durable.player_corpses.insert(
            id.clone(),
            PlayerCorpseState {
                id,
                owner_actor_id: actor_id.to_owned(),
                owner_label: actor.display_name,
                area_id: actor.area_id,
                cell: actor.cell,
                position: actor.position,
                created_tick: self.runtime.durable.tick,
                expiry_tick: expiry,
                credits,
                container,
            },
        );
    }

    pub(super) fn prepare_clone_corpse(&mut self, actor_id: &str) {
        if is_player_like_role(
            self.runtime
                .durable
                .actors
                .get(actor_id)
                .map(|a| a.role.as_str())
                .unwrap_or(""),
        ) {
            self.create_player_corpse(actor_id);
        }
    }

    pub(super) fn restore_skill_backup_after_clone(&mut self, actor_id: &str) {
        let backup = self
            .runtime
            .durable
            .bank_accounts
            .get(actor_id)
            .and_then(|a| a.skill_backup.clone());
        let Some(backup) = backup else {
            return;
        };
        let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) else {
            return;
        };
        actor.professions.learned = backup.learned;
        actor.professions.xp = backup.xp;
        actor.professions.track_xp = backup.track_xp;
        actor.professions.skill_boxes = backup.skill_boxes;
        actor.professions.active_title_id = backup.active_title_id;
        actor.professions.skill_point_cap = backup.skill_point_cap;
        actor.capabilities = ActorCapabilityState::from_professions_and_grants(
            &actor.professions,
            &actor.capability_grants,
        );
        refresh_actor_effective_stats(actor);
    }
    pub(super) fn reset_clone_inventory(
        &mut self,
        actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        self.runtime
            .durable
            .inventory
            .retain(|r| !actor_owns_inventory_container(actor_id, &r.container));
        let container = format!("{actor_id}:field-pack");
        let bodysuit_stack_id = self.next_inventory_stack_id(&container);
        self.runtime.durable.inventory.push(InventoryStackSnapshot {
            stack_id: bodysuit_stack_id,
            container: container.clone(),
            item: "under_bodysuit".to_owned(),
            item_id: STARTER_BODYSUIT_ITEM_ID,
            variant_id: 0,
            quantity: 1,
            reserved: 0,
            available: 1,
        });
        let boots_stack_id = self.next_inventory_stack_id(&container);
        self.runtime.durable.inventory.push(InventoryStackSnapshot {
            stack_id: boots_stack_id,
            container,
            item: "boots_canvas_ankle".to_owned(),
            item_id: STARTER_BOOTS_ITEM_ID,
            variant_id: 0,
            quantity: 1,
            reserved: 0,
            available: 1,
        });
        if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
            actor.worn.clear();
            actor.worn.push(AuthorityActorWornPiece {
                item: "under_bodysuit".to_owned(),
                colors: vec![STARTER_BODYSUIT_COLOR.to_owned()],
            });
            actor.worn.push(AuthorityActorWornPiece {
                item: "boots_canvas_ankle".to_owned(),
                colors: STARTER_BOOTS_COLORS
                    .iter()
                    .map(|color| (*color).to_owned())
                    .collect(),
            });
            actor.worn_colors.insert(
                "under_bodysuit".to_owned(),
                vec![STARTER_BODYSUIT_COLOR.to_owned()],
            );
            actor.worn_colors.insert(
                "boots_canvas_ankle".to_owned(),
                STARTER_BOOTS_COLORS
                    .iter()
                    .map(|color| (*color).to_owned())
                    .collect(),
            );
            actor.equipped_clothing.clear();
            actor.equipped_weapon_id = None;
            actor.equipped_weapon_item_id = 0;
            actor.equipped_weapon_variant_id = 0;
        }
        self.reconcile_actor_clothing(actor_id);
        Ok(())
    }

    pub(super) fn apply_corpse_take_credits(
        &mut self,
        config: &SliceAuthorityConfig,
        corpse_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        let corpse = self
            .runtime
            .durable
            .player_corpses
            .get_mut(corpse_id)
            .ok_or(AuthorityRejectReason::LootTargetUnknown)?;
        if corpse.expiry_tick <= self.runtime.durable.tick || corpse.area_id != actor.area_id {
            return Err(AuthorityRejectReason::LootNotLootable);
        }
        if position_distance_milli(actor.position, corpse.position)
            > HARVEST_INTERACTION_RADIUS_MILLI_CELLS
        {
            return Err(AuthorityRejectReason::LootOutOfRange);
        }
        let amount = corpse.credits;
        if amount == 0 {
            return Err(AuthorityRejectReason::LootInvalidQuantity);
        }
        let total = actor
            .professions
            .credits
            .checked_add(amount)
            .ok_or(AuthorityRejectReason::BankOverflow)?;
        corpse.credits = 0;
        self.runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .expect("actor checked")
            .professions
            .credits = total;
        self.cleanup_player_corpse_if_empty(corpse_id);
        Ok(())
    }

    pub(super) fn cleanup_player_corpse_if_empty(&mut self, corpse_id: &str) {
        let Some(corpse) = self.runtime.durable.player_corpses.get(corpse_id) else {
            return;
        };
        if corpse.credits == 0
            && !self
                .runtime
                .durable
                .inventory
                .iter()
                .any(|row| row.container == corpse.container && row.quantity > 0)
        {
            self.runtime.durable.player_corpses.remove(corpse_id);
        }
    }
}

#[cfg(test)]
mod terminal_tests {
    use super::*;

    fn terminal_prop(id: &str, kind: &str) -> PropSnapshot {
        PropSnapshot {
            id: id.to_owned(),
            entity: format!("entity:{id}"),
            area_id: "open-desert-overworld".to_owned(),
            label: id.to_owned(),
            kind: kind.to_owned(),
            cell: CellSnapshot::new(10, 10),
            size: CellSizeSnapshot { w: 1, h: 1 },
            interactive: true,
            cover: None,
            collision_bounds: Vec::new(),
            door: None,
            container: None,
        }
    }

    #[test]
    fn authored_commerce_and_clone_terminals_all_enter_authority_state() {
        let props = [
            terminal_prop("dustgate-bank-terminal", "bank_terminal"),
            terminal_prop("dustgate-trade-terminal", "trade_terminal"),
            terminal_prop("dustgate-pa-terminal", "pa_terminal"),
            terminal_prop("dustgate-clone-terminal", "clone_terminal"),
        ];
        let terminals = terminals_from_props(&props);
        assert_eq!(
            terminals
                .iter()
                .map(|terminal| (terminal.id.as_str(), terminal.kind.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("dustgate-bank-terminal", "bank_terminal"),
                ("dustgate-trade-terminal", "trade_terminal"),
                ("dustgate-pa-terminal", "pa_terminal"),
                ("dustgate-clone-terminal", "clone_terminal"),
            ]
        );
    }
}

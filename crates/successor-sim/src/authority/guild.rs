use super::*;

pub const GUILD_CHARTER_COST: u64 = 250_000;
pub const GUILD_INVITE_EXPIRY_TICKS: u64 = 2_700;
pub const GUILD_PERMISSION_INVITE: u8 = 1;
pub const GUILD_PERMISSION_KICK: u8 = 2;
pub const GUILD_PERMISSION_ROLES: u8 = 4;
pub const GUILD_PERMISSION_WAR: u8 = 8;
pub const GUILD_PERMISSION_DISBAND: u8 = 16;
pub const GUILD_PERMISSION_ALL: u8 = GUILD_PERMISSION_INVITE
    | GUILD_PERMISSION_KICK
    | GUILD_PERMISSION_ROLES
    | GUILD_PERMISSION_WAR
    | GUILD_PERMISSION_DISBAND;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthorityGuildRole {
    Leader,
    Officer,
    Member,
}

impl AuthorityGuildRole {
    pub fn parse(value: &str) -> Option<Self> {
        match normalize_command_key(value).as_str() {
            "leader" => Some(Self::Leader),
            "officer" => Some(Self::Officer),
            "member" => Some(Self::Member),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Leader => "leader",
            Self::Officer => "officer",
            Self::Member => "member",
        }
    }

    const fn rank(self) -> u8 {
        match self {
            Self::Leader => 2,
            Self::Officer => 1,
            Self::Member => 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuildMemberAuthorityState {
    pub actor_id: String,
    #[serde(default)]
    pub name: String,
    pub role: AuthorityGuildRole,
    #[serde(default)]
    pub permissions: u8,
    #[serde(default)]
    pub last_seen_tick: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_area_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuildAuthorityState {
    pub id: String,
    pub name: String,
    pub normalized_name: String,
    pub tag: String,
    pub normalized_tag: String,
    pub leader_actor_id: String,
    pub created_tick: u64,
    pub members: BTreeMap<String, GuildMemberAuthorityState>,
    #[serde(default)]
    pub war_requests_out: BTreeMap<String, u64>,
    #[serde(default)]
    pub war_requests_in: BTreeMap<String, u64>,
    #[serde(default)]
    pub wars: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingGuildInvite {
    pub id: String,
    pub guild_id: String,
    pub inviter_actor_id: String,
    #[serde(default)]
    pub inviter_name: String,
    pub target_actor_id: String,
    pub issued_tick: u64,
    pub expires_tick: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityGuildMembershipSnapshot {
    pub guild_id: String,
    pub role: AuthorityGuildRole,
    pub permissions: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityGuildWarSnapshot {
    pub opposing_guild_id: String,
    pub opposing_name: String,
    pub opposing_tag: String,
    pub state: String,
    pub declared_tick: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityGuildSummarySnapshot {
    pub id: String,
    pub name: String,
    pub tag: String,
    pub leader_actor_id: String,
    pub created_tick: u64,
    pub member_count: usize,
    pub wars: Vec<AuthorityGuildWarSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityGuildMemberSnapshot {
    pub actor_id: String,
    pub name: String,
    pub role: AuthorityGuildRole,
    pub permissions: Vec<String>,
    pub online: bool,
    #[serde(default)]
    pub area_id: Option<String>,
    pub last_seen_tick: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityGuildInviteSnapshot {
    pub invite_id: String,
    pub guild_id: String,
    pub guild_name: String,
    pub guild_tag: String,
    pub inviter_actor_id: String,
    pub inviter_name: String,
    pub issued_tick: u64,
    pub expires_tick: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityGuildDirectorySnapshot {
    pub id: String,
    pub name: String,
    pub tag: String,
    pub member_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityGuildViewSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guild: Option<AuthorityGuildSummarySnapshot>,
    #[serde(default)]
    pub roster: Vec<AuthorityGuildMemberSnapshot>,
    #[serde(default)]
    pub pending_invites: Vec<AuthorityGuildInviteSnapshot>,
    #[serde(default)]
    pub directory: Vec<AuthorityGuildDirectorySnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityGuildsDeltaPayload {
    pub schema: String,
    pub tick: u64,
    pub guilds: AuthorityGuildViewSnapshot,
}

fn normalize_guild_field(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn display_actor(actor: &ActorAuthorityState) -> String {
    if actor.display_name.is_empty() {
        actor.label.clone()
    } else {
        actor.display_name.clone()
    }
}

fn member_name(
    member: &GuildMemberAuthorityState,
    actors: &BTreeMap<String, ActorAuthorityState>,
) -> String {
    if !member.name.is_empty() {
        return member.name.clone();
    }
    actors
        .get(&member.actor_id)
        .map(display_actor)
        .unwrap_or_else(|| member.actor_id.clone())
}

fn permission_names(mask: u8, role: AuthorityGuildRole) -> Vec<String> {
    if role == AuthorityGuildRole::Leader {
        return ["invite", "kick", "roles", "war", "disband"]
            .into_iter()
            .map(str::to_owned)
            .collect();
    }
    [
        (GUILD_PERMISSION_INVITE, "invite"),
        (GUILD_PERMISSION_KICK, "kick"),
        (GUILD_PERMISSION_ROLES, "roles"),
        (GUILD_PERMISSION_WAR, "war"),
        (GUILD_PERMISSION_DISBAND, "disband"),
    ]
    .into_iter()
    .filter(|(bit, _)| mask & bit != 0)
    .map(|(_, name)| name.to_owned())
    .collect()
}

impl SliceAuthorityState {
    pub fn guild_membership_for_actor(
        &self,
        actor_id: &str,
    ) -> Option<AuthorityGuildMembershipSnapshot> {
        self.runtime.durable.guilds.values().find_map(|guild| {
            guild
                .members
                .get(actor_id)
                .map(|member| AuthorityGuildMembershipSnapshot {
                    guild_id: guild.id.clone(),
                    role: member.role,
                    permissions: if member.role == AuthorityGuildRole::Leader {
                        GUILD_PERMISSION_ALL
                    } else {
                        member.permissions
                    },
                })
        })
    }

    pub(super) fn guild_view_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> AuthorityGuildViewSnapshot {
        let guild = self
            .runtime
            .durable
            .guilds
            .values()
            .find(|guild| guild.members.contains_key(&config.player_actor_id));
        let pending_invites = self.guild_invites_for_actor(&config.player_actor_id);
        let directory = self
            .runtime
            .durable
            .guilds
            .values()
            .map(|guild| AuthorityGuildDirectorySnapshot {
                id: guild.id.clone(),
                name: guild.name.clone(),
                tag: guild.tag.clone(),
                member_count: guild.members.len(),
            })
            .collect();
        let Some(guild) = guild else {
            return AuthorityGuildViewSnapshot {
                guild: None,
                roster: Vec::new(),
                pending_invites,
                directory,
            };
        };

        let roster = guild
            .members
            .values()
            .map(|member| {
                let online = self
                    .runtime
                    .durable
                    .actors
                    .get(&member.actor_id)
                    .is_some_and(|actor| !actor.link_dead);
                AuthorityGuildMemberSnapshot {
                    actor_id: member.actor_id.clone(),
                    name: member_name(member, &self.runtime.durable.actors),
                    role: member.role,
                    permissions: permission_names(member.permissions, member.role),
                    online,
                    area_id: online
                        .then(|| {
                            self.runtime
                                .durable
                                .actors
                                .get(&member.actor_id)
                                .map(|actor| actor.area_id.clone())
                        })
                        .flatten(),
                    last_seen_tick: member.last_seen_tick,
                }
            })
            .collect();
        AuthorityGuildViewSnapshot {
            guild: Some(self.guild_summary(guild)),
            roster,
            pending_invites,
            directory,
        }
    }

    pub(crate) fn guild_views_by_actor_id(&self) -> BTreeMap<String, AuthorityGuildViewSnapshot> {
        self.runtime
            .durable
            .actors
            .keys()
            .map(|actor_id| {
                (
                    actor_id.clone(),
                    self.guild_view_for_observer(&SliceAuthorityConfig {
                        player_actor_id: actor_id.clone(),
                        ..SliceAuthorityConfig::default()
                    }),
                )
            })
            .collect()
    }

    fn guild_summary(&self, guild: &GuildAuthorityState) -> AuthorityGuildSummarySnapshot {
        let mut wars = Vec::new();
        for (opposing_id, declared_tick) in &guild.war_requests_out {
            if let Some(opposing) = self.runtime.durable.guilds.get(opposing_id) {
                wars.push(AuthorityGuildWarSnapshot {
                    opposing_guild_id: opposing.id.clone(),
                    opposing_name: opposing.name.clone(),
                    opposing_tag: opposing.tag.clone(),
                    state: "outgoing".to_owned(),
                    declared_tick: *declared_tick,
                });
            }
        }
        for (opposing_id, declared_tick) in &guild.war_requests_in {
            if let Some(opposing) = self.runtime.durable.guilds.get(opposing_id) {
                wars.push(AuthorityGuildWarSnapshot {
                    opposing_guild_id: opposing.id.clone(),
                    opposing_name: opposing.name.clone(),
                    opposing_tag: opposing.tag.clone(),
                    state: "incoming".to_owned(),
                    declared_tick: *declared_tick,
                });
            }
        }
        for (opposing_id, declared_tick) in &guild.wars {
            if let Some(opposing) = self.runtime.durable.guilds.get(opposing_id) {
                wars.push(AuthorityGuildWarSnapshot {
                    opposing_guild_id: opposing.id.clone(),
                    opposing_name: opposing.name.clone(),
                    opposing_tag: opposing.tag.clone(),
                    state: "mutual".to_owned(),
                    declared_tick: *declared_tick,
                });
            }
        }
        AuthorityGuildSummarySnapshot {
            id: guild.id.clone(),
            name: guild.name.clone(),
            tag: guild.tag.clone(),
            leader_actor_id: guild.leader_actor_id.clone(),
            created_tick: guild.created_tick,
            member_count: guild.members.len(),
            wars,
        }
    }

    fn guild_invites_for_actor(&self, actor_id: &str) -> Vec<AuthorityGuildInviteSnapshot> {
        self.runtime
            .durable
            .guild_invites
            .values()
            .filter(|invite| {
                invite.target_actor_id == actor_id
                    && invite.expires_tick > self.runtime.durable.tick
            })
            .filter_map(|invite| {
                self.runtime
                    .durable
                    .guilds
                    .get(&invite.guild_id)
                    .map(|guild| AuthorityGuildInviteSnapshot {
                        invite_id: invite.id.clone(),
                        guild_id: guild.id.clone(),
                        guild_name: guild.name.clone(),
                        guild_tag: guild.tag.clone(),
                        inviter_actor_id: invite.inviter_actor_id.clone(),
                        inviter_name: if invite.inviter_name.is_empty() {
                            self.runtime
                                .durable
                                .actors
                                .get(&invite.inviter_actor_id)
                                .map(display_actor)
                                .unwrap_or_else(|| invite.inviter_actor_id.clone())
                        } else {
                            invite.inviter_name.clone()
                        },
                        issued_tick: invite.issued_tick,
                        expires_tick: invite.expires_tick,
                    })
            })
            .collect()
    }

    pub(super) fn tick_guilds(&mut self) {
        self.runtime
            .durable
            .guild_invites
            .retain(|_, invite| invite.expires_tick > self.runtime.durable.tick);
        for guild in self.runtime.durable.guilds.values_mut() {
            for member in guild.members.values_mut() {
                if let Some(actor) = self.runtime.durable.actors.get(&member.actor_id) {
                    if !actor.display_name.is_empty() {
                        member.name = display_actor(actor);
                    }
                    if !actor.link_dead {
                        member.last_seen_tick = self.runtime.durable.tick;
                        member.last_area_id = Some(actor.area_id.clone());
                    }
                }
            }
        }
    }

    fn guild_for_actor(&self, actor_id: &str) -> Option<(String, AuthorityGuildRole, u8)> {
        self.guild_membership_for_actor(actor_id)
            .map(|membership| (membership.guild_id, membership.role, membership.permissions))
    }

    fn require_permission(
        &self,
        actor_id: &str,
        guild_id: &str,
        permission: u8,
    ) -> Result<(), AuthorityRejectReason> {
        let member = self
            .runtime
            .durable
            .guilds
            .get(guild_id)
            .and_then(|guild| guild.members.get(actor_id))
            .ok_or(AuthorityRejectReason::NotInGuild)?;
        if member.role == AuthorityGuildRole::Leader || member.permissions & permission != 0 {
            Ok(())
        } else {
            Err(AuthorityRejectReason::NoGuildPermission)
        }
    }

    fn can_manage_member(
        guild: &GuildAuthorityState,
        actor_id: &str,
        target_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        if actor_id == target_id {
            return Err(AuthorityRejectReason::NoGuildPermission);
        }
        let actor = guild
            .members
            .get(actor_id)
            .ok_or(AuthorityRejectReason::NotInGuild)?;
        let target = guild
            .members
            .get(target_id)
            .ok_or(AuthorityRejectReason::NotInGuild)?;
        if actor.role.rank() <= target.role.rank() {
            return Err(AuthorityRejectReason::NoGuildPermission);
        }
        Ok(())
    }

    fn nearby_pa_terminal(&self, actor: &ActorAuthorityState, prop_id: &str) -> bool {
        self.runtime.durable.world.terminals.iter().any(|terminal| {
            terminal.id == prop_id
                && terminal.kind == "pa_terminal"
                && terminal.area_id == actor.area_id
                && position_distance_milli(
                    actor.position,
                    AuthorityPosition::from_cell(terminal.cell),
                ) <= 1_750
        })
    }

    pub(super) fn sync_guild_actor_fields(&mut self) {
        let guild_ids = self
            .runtime
            .durable
            .guilds
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        for actor in self.runtime.durable.actors.values_mut() {
            if actor
                .player_organization_id
                .as_ref()
                .is_some_and(|id| id.starts_with("guild-") || guild_ids.contains(id))
            {
                actor.player_organization_id = None;
                actor.player_organization_tag = None;
            }
        }
        for guild in self.runtime.durable.guilds.values() {
            for actor_id in guild.members.keys() {
                if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
                    actor.player_organization_id = Some(guild.id.clone());
                    actor.player_organization_tag = Some(guild.tag.clone());
                }
            }
        }
    }

    pub(super) fn sync_guild_member_name(&mut self, actor_id: &str) {
        let Some(name) = self.runtime.durable.actors.get(actor_id).map(display_actor) else {
            return;
        };
        for guild in self.runtime.durable.guilds.values_mut() {
            if let Some(member) = guild.members.get_mut(actor_id) {
                member.name = name.clone();
            }
        }
    }

    pub(super) fn apply_guild_create(
        &mut self,
        config: &SliceAuthorityConfig,
        name: &str,
        tag: &str,
        terminal_prop_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        if self.guild_for_actor(&actor.id).is_some() {
            return Err(AuthorityRejectReason::AlreadyInGuild);
        }
        let name = name.trim();
        let tag = tag.trim();
        if name.is_empty() || name.chars().count() > 48 {
            return Err(AuthorityRejectReason::GuildNameTooLong);
        }
        if tag.is_empty() || tag.chars().count() > 8 {
            return Err(AuthorityRejectReason::GuildTagTooLong);
        }
        let normalized_name = normalize_guild_field(name);
        let normalized_tag = normalize_guild_field(tag);
        if self
            .runtime
            .durable
            .guilds
            .values()
            .any(|guild| guild.normalized_name == normalized_name)
        {
            return Err(AuthorityRejectReason::GuildNameExists);
        }
        if self
            .runtime
            .durable
            .guilds
            .values()
            .any(|guild| guild.normalized_tag == normalized_tag)
        {
            return Err(AuthorityRejectReason::GuildTagExists);
        }
        if !self.nearby_pa_terminal(&actor, terminal_prop_id) {
            return Err(AuthorityRejectReason::NotAtPaTerminal);
        }
        if actor.professions.credits < GUILD_CHARTER_COST {
            return Err(AuthorityRejectReason::InsufficientCredits);
        }
        let id = format!("guild-{}", self.runtime.durable.next_guild_id);
        self.runtime.durable.next_guild_id = self.runtime.durable.next_guild_id.saturating_add(1);
        self.runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .expect("guild creator remains registered")
            .professions
            .credits -= GUILD_CHARTER_COST;
        let mut members = BTreeMap::new();
        members.insert(
            actor.id.clone(),
            GuildMemberAuthorityState {
                actor_id: actor.id.clone(),
                name: display_actor(&actor),
                role: AuthorityGuildRole::Leader,
                permissions: GUILD_PERMISSION_ALL,
                last_seen_tick: self.runtime.durable.tick,
                last_area_id: Some(actor.area_id.clone()),
            },
        );
        self.runtime.durable.guilds.insert(
            id.clone(),
            GuildAuthorityState {
                id,
                name: name.to_owned(),
                normalized_name,
                tag: tag.to_owned(),
                normalized_tag,
                leader_actor_id: actor.id,
                created_tick: self.runtime.durable.tick,
                members,
                war_requests_out: BTreeMap::new(),
                war_requests_in: BTreeMap::new(),
                wars: BTreeMap::new(),
            },
        );
        self.sync_guild_actor_fields();
        Ok(())
    }

    pub(super) fn apply_guild_invite(
        &mut self,
        config: &SliceAuthorityConfig,
        target_actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let (guild_id, _, _) = self
            .guild_for_actor(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::NotInGuild)?;
        self.require_permission(&config.player_actor_id, &guild_id, GUILD_PERMISSION_INVITE)?;
        if !self.runtime.durable.actors.contains_key(target_actor_id) {
            return Err(AuthorityRejectReason::UnknownActor);
        }
        if self.guild_for_actor(target_actor_id).is_some() {
            return Err(AuthorityRejectReason::AlreadyInGuild);
        }
        self.runtime
            .durable
            .guild_invites
            .retain(|_, invite| invite.expires_tick > self.runtime.durable.tick);
        if self
            .runtime
            .durable
            .guild_invites
            .values()
            .any(|invite| invite.guild_id == guild_id && invite.target_actor_id == target_actor_id)
        {
            return Err(AuthorityRejectReason::InviteAlreadyPending);
        }
        let inviter_name = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .map(display_actor)
            .unwrap_or_else(|| config.player_actor_id.clone());
        let id = format!("invite-{}", self.runtime.durable.next_guild_invite_id);
        self.runtime.durable.next_guild_invite_id =
            self.runtime.durable.next_guild_invite_id.saturating_add(1);
        self.runtime.durable.guild_invites.insert(
            id.clone(),
            PendingGuildInvite {
                id,
                guild_id,
                inviter_actor_id: config.player_actor_id.clone(),
                inviter_name,
                target_actor_id: target_actor_id.to_owned(),
                issued_tick: self.runtime.durable.tick,
                expires_tick: self
                    .runtime
                    .durable
                    .tick
                    .saturating_add(GUILD_INVITE_EXPIRY_TICKS),
            },
        );
        Ok(())
    }

    pub(super) fn apply_guild_accept_invite(
        &mut self,
        config: &SliceAuthorityConfig,
        invite_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let invite = self
            .runtime
            .durable
            .guild_invites
            .get(invite_id)
            .cloned()
            .ok_or(AuthorityRejectReason::InviteNotFound)?;
        if invite.target_actor_id != config.player_actor_id {
            return Err(AuthorityRejectReason::InviteNotFound);
        }
        if invite.expires_tick <= self.runtime.durable.tick {
            self.runtime.durable.guild_invites.remove(invite_id);
            return Err(AuthorityRejectReason::InviteExpired);
        }
        if self.guild_for_actor(&invite.target_actor_id).is_some() {
            return Err(AuthorityRejectReason::AlreadyInGuild);
        }
        let name = self
            .runtime
            .durable
            .actors
            .get(&invite.target_actor_id)
            .map(display_actor)
            .unwrap_or_else(|| invite.target_actor_id.clone());
        let last_area_id = self
            .runtime
            .durable
            .actors
            .get(&invite.target_actor_id)
            .filter(|actor| !actor.link_dead)
            .map(|actor| actor.area_id.clone());
        let guild = self
            .runtime
            .durable
            .guilds
            .get_mut(&invite.guild_id)
            .ok_or(AuthorityRejectReason::GuildNotFound)?;
        guild.members.insert(
            invite.target_actor_id.clone(),
            GuildMemberAuthorityState {
                actor_id: invite.target_actor_id.clone(),
                name,
                role: AuthorityGuildRole::Member,
                permissions: 0,
                last_seen_tick: self.runtime.durable.tick,
                last_area_id,
            },
        );
        self.runtime
            .durable
            .guild_invites
            .retain(|_, sibling| sibling.target_actor_id != invite.target_actor_id);
        self.sync_guild_actor_fields();
        Ok(())
    }

    pub(super) fn apply_guild_decline_invite(
        &mut self,
        config: &SliceAuthorityConfig,
        invite_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let invite = self
            .runtime
            .durable
            .guild_invites
            .get(invite_id)
            .ok_or(AuthorityRejectReason::InviteNotFound)?;
        if invite.target_actor_id != config.player_actor_id {
            return Err(AuthorityRejectReason::InviteNotFound);
        }
        self.runtime.durable.guild_invites.remove(invite_id);
        Ok(())
    }

    pub(super) fn apply_guild_leave(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        let (guild_id, role, _) = self
            .guild_for_actor(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::NotInGuild)?;
        if role == AuthorityGuildRole::Leader {
            return Err(AuthorityRejectReason::NoGuildPermission);
        }
        self.runtime
            .durable
            .guilds
            .get_mut(&guild_id)
            .expect("membership guild exists")
            .members
            .remove(&config.player_actor_id);
        self.sync_guild_actor_fields();
        Ok(())
    }

    pub(super) fn apply_guild_kick(
        &mut self,
        config: &SliceAuthorityConfig,
        target_actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let (guild_id, _, _) = self
            .guild_for_actor(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::NotInGuild)?;
        self.require_permission(&config.player_actor_id, &guild_id, GUILD_PERMISSION_KICK)?;
        let guild = self
            .runtime
            .durable
            .guilds
            .get_mut(&guild_id)
            .ok_or(AuthorityRejectReason::GuildNotFound)?;
        Self::can_manage_member(guild, &config.player_actor_id, target_actor_id)?;
        guild.members.remove(target_actor_id);
        self.sync_guild_actor_fields();
        Ok(())
    }

    pub(super) fn apply_guild_set_role(
        &mut self,
        config: &SliceAuthorityConfig,
        target_actor_id: &str,
        role: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let (guild_id, _, _) = self
            .guild_for_actor(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::NotInGuild)?;
        self.require_permission(&config.player_actor_id, &guild_id, GUILD_PERMISSION_ROLES)?;
        let role =
            AuthorityGuildRole::parse(role).ok_or(AuthorityRejectReason::TargetUnavailable)?;
        if role == AuthorityGuildRole::Leader {
            return Err(AuthorityRejectReason::NoGuildPermission);
        }
        let guild = self
            .runtime
            .durable
            .guilds
            .get_mut(&guild_id)
            .ok_or(AuthorityRejectReason::GuildNotFound)?;
        Self::can_manage_member(guild, &config.player_actor_id, target_actor_id)?;
        let member = guild
            .members
            .get_mut(target_actor_id)
            .ok_or(AuthorityRejectReason::NotInGuild)?;
        member.role = role;
        self.sync_guild_actor_fields();
        Ok(())
    }

    pub(super) fn apply_guild_set_permissions(
        &mut self,
        config: &SliceAuthorityConfig,
        target_actor_id: &str,
        permissions: u8,
    ) -> Result<(), AuthorityRejectReason> {
        let (guild_id, _, _) = self
            .guild_for_actor(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::NotInGuild)?;
        self.require_permission(&config.player_actor_id, &guild_id, GUILD_PERMISSION_ROLES)?;
        let guild = self
            .runtime
            .durable
            .guilds
            .get_mut(&guild_id)
            .ok_or(AuthorityRejectReason::GuildNotFound)?;
        Self::can_manage_member(guild, &config.player_actor_id, target_actor_id)?;
        let member = guild
            .members
            .get_mut(target_actor_id)
            .ok_or(AuthorityRejectReason::NotInGuild)?;
        member.permissions = permissions & GUILD_PERMISSION_ALL;
        self.sync_guild_actor_fields();
        Ok(())
    }

    pub(super) fn apply_guild_transfer_leadership(
        &mut self,
        config: &SliceAuthorityConfig,
        target_actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let (guild_id, role, _) = self
            .guild_for_actor(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::NotInGuild)?;
        if role != AuthorityGuildRole::Leader {
            return Err(AuthorityRejectReason::NoGuildPermission);
        }
        let guild = self
            .runtime
            .durable
            .guilds
            .get_mut(&guild_id)
            .ok_or(AuthorityRejectReason::GuildNotFound)?;
        if !guild.members.contains_key(target_actor_id) || target_actor_id == config.player_actor_id
        {
            return Err(AuthorityRejectReason::NotInGuild);
        }
        guild.leader_actor_id = target_actor_id.to_owned();
        guild
            .members
            .get_mut(&config.player_actor_id)
            .expect("leader membership exists")
            .role = AuthorityGuildRole::Officer;
        guild
            .members
            .get_mut(target_actor_id)
            .expect("target membership exists")
            .role = AuthorityGuildRole::Leader;
        self.sync_guild_actor_fields();
        Ok(())
    }

    pub(super) fn apply_guild_disband(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        let (guild_id, _, _) = self
            .guild_for_actor(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::NotInGuild)?;
        self.require_permission(&config.player_actor_id, &guild_id, GUILD_PERMISSION_DISBAND)?;
        let member_ids = self
            .runtime
            .durable
            .guilds
            .get(&guild_id)
            .map(|guild| guild.members.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        self.runtime.durable.guilds.remove(&guild_id);
        for guild in self.runtime.durable.guilds.values_mut() {
            guild.war_requests_out.remove(&guild_id);
            guild.war_requests_in.remove(&guild_id);
            guild.wars.remove(&guild_id);
        }
        self.runtime
            .durable
            .guild_invites
            .retain(|_, invite| invite.guild_id != guild_id);
        for actor_id in member_ids {
            if let Some(actor) = self.runtime.durable.actors.get_mut(&actor_id) {
                actor.player_organization_id = None;
                actor.player_organization_tag = None;
            }
        }
        self.sync_guild_actor_fields();
        Ok(())
    }

    pub(super) fn apply_guild_declare_war(
        &mut self,
        config: &SliceAuthorityConfig,
        opposing_guild_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let (guild_id, _, _) = self
            .guild_for_actor(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::NotInGuild)?;
        self.require_permission(&config.player_actor_id, &guild_id, GUILD_PERMISSION_WAR)?;
        if guild_id == opposing_guild_id
            || !self.runtime.durable.guilds.contains_key(opposing_guild_id)
        {
            return Err(AuthorityRejectReason::GuildNotFound);
        }
        if self
            .runtime
            .durable
            .guilds
            .get(&guild_id)
            .is_some_and(|guild| {
                guild.wars.contains_key(opposing_guild_id)
                    || guild.war_requests_out.contains_key(opposing_guild_id)
            })
        {
            return Err(AuthorityRejectReason::AlreadyWaring);
        }
        let reciprocal_tick = self
            .runtime
            .durable
            .guilds
            .get(opposing_guild_id)
            .and_then(|guild| guild.war_requests_out.get(&guild_id))
            .copied();
        if let Some(declared_tick) = reciprocal_tick {
            self.runtime
                .durable
                .guilds
                .get_mut(&guild_id)
                .expect("guild exists")
                .war_requests_in
                .remove(opposing_guild_id);
            self.runtime
                .durable
                .guilds
                .get_mut(opposing_guild_id)
                .expect("opposing guild exists")
                .war_requests_out
                .remove(&guild_id);
            self.runtime
                .durable
                .guilds
                .get_mut(&guild_id)
                .expect("guild exists")
                .wars
                .insert(opposing_guild_id.to_owned(), declared_tick);
            self.runtime
                .durable
                .guilds
                .get_mut(opposing_guild_id)
                .expect("opposing guild exists")
                .wars
                .insert(guild_id, declared_tick);
        } else {
            self.runtime
                .durable
                .guilds
                .get_mut(&guild_id)
                .expect("guild exists")
                .war_requests_out
                .insert(opposing_guild_id.to_owned(), self.runtime.durable.tick);
            self.runtime
                .durable
                .guilds
                .get_mut(opposing_guild_id)
                .expect("opposing guild exists")
                .war_requests_in
                .insert(guild_id, self.runtime.durable.tick);
        }
        Ok(())
    }

    pub(super) fn apply_guild_accept_war(
        &mut self,
        config: &SliceAuthorityConfig,
        opposing_guild_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let (guild_id, _, _) = self
            .guild_for_actor(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::NotInGuild)?;
        self.require_permission(&config.player_actor_id, &guild_id, GUILD_PERMISSION_WAR)?;
        let declared_tick = self
            .runtime
            .durable
            .guilds
            .get(&guild_id)
            .and_then(|guild| guild.war_requests_in.get(opposing_guild_id))
            .copied()
            .ok_or(AuthorityRejectReason::NotWaring)?;
        if !self.runtime.durable.guilds.contains_key(opposing_guild_id) {
            return Err(AuthorityRejectReason::GuildNotFound);
        }
        self.runtime
            .durable
            .guilds
            .get_mut(&guild_id)
            .expect("guild exists")
            .war_requests_in
            .remove(opposing_guild_id);
        self.runtime
            .durable
            .guilds
            .get_mut(opposing_guild_id)
            .expect("opposing guild exists")
            .war_requests_out
            .remove(&guild_id);
        self.runtime
            .durable
            .guilds
            .get_mut(&guild_id)
            .expect("guild exists")
            .wars
            .insert(opposing_guild_id.to_owned(), declared_tick);
        self.runtime
            .durable
            .guilds
            .get_mut(opposing_guild_id)
            .expect("opposing guild exists")
            .wars
            .insert(guild_id, declared_tick);
        Ok(())
    }

    pub(super) fn apply_guild_rescind_war(
        &mut self,
        config: &SliceAuthorityConfig,
        opposing_guild_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let (guild_id, _, _) = self
            .guild_for_actor(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::NotInGuild)?;
        self.require_permission(&config.player_actor_id, &guild_id, GUILD_PERMISSION_WAR)?;
        let changed = self
            .runtime
            .durable
            .guilds
            .get_mut(&guild_id)
            .expect("guild exists")
            .war_requests_out
            .remove(opposing_guild_id)
            .is_some()
            || self
                .runtime
                .durable
                .guilds
                .get_mut(&guild_id)
                .expect("guild exists")
                .war_requests_in
                .remove(opposing_guild_id)
                .is_some()
            || self
                .runtime
                .durable
                .guilds
                .get_mut(&guild_id)
                .expect("guild exists")
                .wars
                .remove(opposing_guild_id)
                .is_some();
        if !changed {
            return Err(AuthorityRejectReason::NotWaring);
        }
        if let Some(opposing) = self.runtime.durable.guilds.get_mut(opposing_guild_id) {
            opposing.war_requests_out.remove(&guild_id);
            opposing.war_requests_in.remove(&guild_id);
            opposing.wars.remove(&guild_id);
        }
        Ok(())
    }

    pub(super) fn write_guilds_stable_hash(&self, writer: &mut StateWriter) {
        if self.runtime.durable.guilds.is_empty()
            && self.runtime.durable.guild_invites.is_empty()
            && self.runtime.durable.next_guild_id <= 1
            && self.runtime.durable.next_guild_invite_id <= 1
        {
            return;
        }
        write_string(writer, "guilds.v2");
        writer
            .write_u64(self.runtime.durable.next_guild_id)
            .write_u64(self.runtime.durable.next_guild_invite_id)
            .write_u32(self.runtime.durable.guilds.len() as u32);
        for guild in self.runtime.durable.guilds.values() {
            write_string(writer, &guild.id);
            write_string(writer, &guild.name);
            write_string(writer, &guild.normalized_name);
            write_string(writer, &guild.tag);
            write_string(writer, &guild.normalized_tag);
            write_string(writer, &guild.leader_actor_id);
            writer.write_tick(guild.created_tick);
            writer.write_u32(guild.members.len() as u32);
            for member in guild.members.values() {
                write_string(writer, &member.actor_id);
                write_string(writer, &member.name);
                write_string(writer, member.role.as_str());
                writer
                    .write_u32(member.permissions as u32)
                    .write_tick(member.last_seen_tick);
                write_optional_string(writer, member.last_area_id.as_deref());
            }
            writer.write_u32(guild.war_requests_out.len() as u32);
            for (opposing_id, declared_tick) in &guild.war_requests_out {
                write_string(writer, opposing_id);
                writer.write_tick(*declared_tick);
            }
            writer.write_u32(guild.war_requests_in.len() as u32);
            for (opposing_id, declared_tick) in &guild.war_requests_in {
                write_string(writer, opposing_id);
                writer.write_tick(*declared_tick);
            }
            writer.write_u32(guild.wars.len() as u32);
            for (opposing_id, declared_tick) in &guild.wars {
                write_string(writer, opposing_id);
                writer.write_tick(*declared_tick);
            }
        }
        writer.write_u32(self.runtime.durable.guild_invites.len() as u32);
        for invite in self.runtime.durable.guild_invites.values() {
            write_string(writer, &invite.id);
            write_string(writer, &invite.guild_id);
            write_string(writer, &invite.inviter_actor_id);
            write_string(writer, &invite.inviter_name);
            write_string(writer, &invite.target_actor_id);
            writer
                .write_tick(invite.issued_tick)
                .write_tick(invite.expires_tick);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_with_actors() -> SliceAuthorityState {
        SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).expect("test slice")
    }

    fn add_actor(state: &mut SliceAuthorityState, actor_id: &str, name: &str) {
        let mut actor = state
            .runtime
            .durable
            .actors
            .get("player")
            .expect("fixture player")
            .clone();
        actor.id = actor_id.to_owned();
        actor.label = name.to_owned();
        actor.display_name = name.to_owned();
        actor.player_organization_id = None;
        actor.player_organization_tag = None;
        actor.professions.credits = GUILD_CHARTER_COST * 2;
        state
            .runtime
            .durable
            .actors
            .insert(actor_id.to_owned(), actor);
    }

    fn member(actor_id: &str, name: &str, role: AuthorityGuildRole) -> GuildMemberAuthorityState {
        GuildMemberAuthorityState {
            actor_id: actor_id.to_owned(),
            name: name.to_owned(),
            role,
            permissions: if role == AuthorityGuildRole::Leader {
                GUILD_PERMISSION_ALL
            } else {
                0
            },
            last_seen_tick: 12,
            last_area_id: Some("open-desert-overworld".to_owned()),
        }
    }

    fn insert_guild(state: &mut SliceAuthorityState, id: &str, leader: &str, name: &str) {
        let mut members = BTreeMap::new();
        members.insert(
            leader.to_owned(),
            member(leader, leader, AuthorityGuildRole::Leader),
        );
        state.runtime.durable.guilds.insert(
            id.to_owned(),
            GuildAuthorityState {
                id: id.to_owned(),
                name: name.to_owned(),
                normalized_name: normalize_guild_field(name),
                tag: id.to_owned(),
                normalized_tag: id.to_lowercase(),
                leader_actor_id: leader.to_owned(),
                created_tick: 12,
                members,
                war_requests_out: BTreeMap::new(),
                war_requests_in: BTreeMap::new(),
                wars: BTreeMap::new(),
            },
        );
        state.sync_guild_actor_fields();
    }

    fn config(actor_id: &str) -> SliceAuthorityConfig {
        SliceAuthorityConfig {
            player_actor_id: actor_id.to_owned(),
            ..SliceAuthorityConfig::default()
        }
    }

    #[test]
    fn guild_view_hides_offline_location_and_exposes_directory_to_outsider() {
        let mut state = state_with_actors();
        add_actor(&mut state, "offline", "Absent Pawn");
        insert_guild(&mut state, "guild-a", "player", "Dust Wardens");
        state
            .guilds
            .get_mut("guild-a")
            .expect("guild")
            .members
            .insert(
                "offline".to_owned(),
                member("offline", "Absent Pawn", AuthorityGuildRole::Member),
            );
        state.actors.get_mut("offline").expect("offline").link_dead = true;
        let member_view = state.guild_view_for_observer(&config("player"));
        let offline = member_view
            .roster
            .iter()
            .find(|row| row.actor_id == "offline")
            .expect("offline row");
        assert!(!offline.online);
        assert_eq!(offline.area_id, None);
        assert_eq!(offline.name, "Absent Pawn");
        assert_eq!(offline.last_seen_tick, 12);
        state.actors.remove("offline");
        state.tick = 13;
        state.tick_guilds();
        let blob = state.export_checkpoint();
        let mut restored = state.clone();
        restored.restore_checkpoint(blob).expect("offline restore");
        let restored_view = restored.guild_view_for_observer(&config("player"));
        let restored_offline = restored_view
            .roster
            .iter()
            .find(|row| row.actor_id == "offline")
            .expect("offline persisted row");
        assert_eq!(restored_offline.name, "Absent Pawn");
        assert_eq!(restored_offline.last_seen_tick, 12);
        assert_eq!(restored_offline.area_id, None);

        add_actor(&mut state, "outsider", "Outsider");
        let outsider = state.guild_view_for_observer(&config("outsider"));
        assert!(outsider.guild.is_none());
        assert!(outsider.roster.is_empty());
        assert_eq!(outsider.directory.len(), 1);
        assert_eq!(outsider.directory[0].id, "guild-a");
    }

    #[test]
    fn guild_wars_project_and_cleanup_cross_references() {
        let mut state = state_with_actors();
        add_actor(&mut state, "leader-b", "Leader B");
        insert_guild(&mut state, "guild-a", "player", "Alpha");
        insert_guild(&mut state, "guild-b", "leader-b", "Beta");
        state
            .apply_guild_declare_war(&config("player"), "guild-b")
            .expect("declare");
        let outgoing = state.guild_view_for_observer(&config("player"));
        assert_eq!(outgoing.guild.as_ref().unwrap().wars[0].state, "outgoing");
        state
            .apply_guild_accept_war(&config("leader-b"), "guild-a")
            .expect("accept");
        assert_eq!(state.guilds["guild-a"].wars["guild-b"], state.tick);
        assert_eq!(state.guilds["guild-b"].wars["guild-a"], state.tick);
        state
            .apply_guild_rescind_war(&config("player"), "guild-b")
            .expect("rescind");
        assert!(state.guilds["guild-a"].wars.is_empty());
        assert!(state.guilds["guild-b"].wars.is_empty());
    }

    #[test]
    fn guild_invites_reject_duplicates_and_accept_or_expire() {
        let mut state = state_with_actors();
        add_actor(&mut state, "target", "Target");
        insert_guild(&mut state, "guild-a", "player", "Alpha");
        state
            .apply_guild_invite(&config("player"), "target")
            .expect("invite");
        assert_eq!(
            state.apply_guild_invite(&config("player"), "target"),
            Err(AuthorityRejectReason::InviteAlreadyPending)
        );
        let invite_id = state
            .guild_invites
            .keys()
            .next()
            .cloned()
            .expect("invite id");
        state
            .apply_guild_accept_invite(&config("target"), &invite_id)
            .expect("accept");
        assert!(state.guild_membership_for_actor("target").is_some());
        assert!(state.guild_invites.is_empty());

        add_actor(&mut state, "other", "Other");
        state
            .apply_guild_invite(&config("player"), "other")
            .expect("second invite");
        let other_invite = state
            .guild_invites
            .keys()
            .next()
            .cloned()
            .expect("second invite id");
        state.tick = state.guild_invites[&other_invite].expires_tick;
        assert_eq!(
            state.apply_guild_accept_invite(&config("other"), &other_invite),
            Err(AuthorityRejectReason::InviteExpired)
        );
        assert!(state.guild_invites.is_empty());
    }

    #[test]
    fn guild_create_validates_terminal_and_charges_exact_charter_fee() {
        let mut state = state_with_actors();
        let terminal = AuthorityTerminalState {
            id: "pa-1".to_owned(),
            kind: "pa_terminal".to_owned(),
            area_id: "open-desert-overworld".to_owned(),
            cell: AuthorityCell { x: 37, y: 21 },
        };
        state.terminals.push(terminal.clone());
        let before_id = state.next_guild_id;
        let actor = state.actors.get_mut("player").expect("player");
        actor.area_id = terminal.area_id.clone();
        actor.position = AuthorityPosition::from_cell(terminal.cell);
        actor.professions.credits = GUILD_CHARTER_COST + 17;
        let before = actor.professions.credits;
        assert_eq!(
            state.apply_guild_create(&config("player"), "Dust", "DST", "wrong"),
            Err(AuthorityRejectReason::NotAtPaTerminal)
        );
        assert_eq!(state.actors["player"].professions.credits, before);
        assert_eq!(state.next_guild_id, before_id);
        state.terminals[0].kind = "bank_terminal".to_owned();
        assert_eq!(
            state.apply_guild_create(&config("player"), "Dust", "DST", &terminal.id),
            Err(AuthorityRejectReason::NotAtPaTerminal)
        );
        state.terminals[0].kind = "pa_terminal".to_owned();
        state.terminals[0].area_id = "other-area".to_owned();
        assert_eq!(
            state.apply_guild_create(&config("player"), "Dust", "DST", &terminal.id),
            Err(AuthorityRejectReason::NotAtPaTerminal)
        );
        state.terminals[0].area_id = terminal.area_id.clone();
        state.actors.get_mut("player").expect("player").position =
            AuthorityPosition::from_cell(AuthorityCell { x: 40, y: 21 });
        assert_eq!(
            state.apply_guild_create(&config("player"), "Dust", "DST", &terminal.id),
            Err(AuthorityRejectReason::NotAtPaTerminal)
        );
        state.actors.get_mut("player").expect("player").position =
            AuthorityPosition::from_cell(terminal.cell);
        state
            .actors
            .get_mut("player")
            .expect("player")
            .professions
            .credits = GUILD_CHARTER_COST - 1;
        assert_eq!(
            state.apply_guild_create(&config("player"), "Dust", "DST", &terminal.id),
            Err(AuthorityRejectReason::InsufficientCredits)
        );
        assert_eq!(state.next_guild_id, before_id);
        state
            .actors
            .get_mut("player")
            .expect("player")
            .professions
            .credits = before;
        state
            .apply_guild_create(&config("player"), "Dust Wardens", "DST", &terminal.id)
            .expect("charter");
        assert_eq!(state.actors["player"].professions.credits, 17);
        assert_eq!(state.next_guild_id, before_id + 1);
        assert_eq!(
            state.guilds["guild-1"].members["player"].permissions,
            GUILD_PERMISSION_ALL
        );

        add_actor(&mut state, "second", "Second");
        let second = state.actors.get_mut("second").expect("second");
        second.area_id = terminal.area_id;
        second.position = AuthorityPosition::from_cell(terminal.cell);
        second.professions.credits = GUILD_CHARTER_COST;
        assert_eq!(
            state.apply_guild_create(&config("second"), "dust  wardens", "NEW", &terminal.id),
            Err(AuthorityRejectReason::GuildNameExists)
        );
        assert_eq!(
            state.apply_guild_create(&config("second"), "Other", "dst", &terminal.id),
            Err(AuthorityRejectReason::GuildTagExists)
        );
    }

    #[test]
    fn guild_roles_masks_transfer_leave_and_management_hierarchy() {
        let mut state = state_with_actors();
        add_actor(&mut state, "officer", "Officer");
        add_actor(&mut state, "member", "Member");
        insert_guild(&mut state, "guild-a", "player", "Alpha");
        let guild = state.guilds.get_mut("guild-a").expect("guild");
        guild.members.insert(
            "officer".to_owned(),
            member("officer", "Officer", AuthorityGuildRole::Member),
        );
        guild.members.insert(
            "member".to_owned(),
            member("member", "Member", AuthorityGuildRole::Member),
        );
        state.sync_guild_actor_fields();
        state
            .apply_guild_set_role(&config("player"), "officer", "officer")
            .expect("role");
        state
            .apply_guild_set_permissions(&config("player"), "officer", 255)
            .expect("mask");
        assert_eq!(
            state.guilds["guild-a"].members["officer"].permissions,
            GUILD_PERMISSION_ALL
        );
        assert_eq!(
            state
                .guild_view_for_observer(&config("officer"))
                .roster
                .iter()
                .find(|m| m.actor_id == "officer")
                .unwrap()
                .permissions,
            vec!["invite", "kick", "roles", "war", "disband"]
        );
        assert_eq!(
            state.apply_guild_set_role(&config("officer"), "player", "member"),
            Err(AuthorityRejectReason::NoGuildPermission)
        );
        assert_eq!(
            state.apply_guild_set_role(&config("player"), "officer", "officer2"),
            Err(AuthorityRejectReason::TargetUnavailable)
        );
        assert_eq!(
            state.apply_guild_set_role(&config("player"), "player", "member"),
            Err(AuthorityRejectReason::NoGuildPermission)
        );
        state
            .apply_guild_transfer_leadership(&config("player"), "officer")
            .expect("transfer");
        assert_eq!(state.guilds["guild-a"].leader_actor_id, "officer");
        assert_eq!(
            state.guilds["guild-a"].members["officer"].role,
            AuthorityGuildRole::Leader
        );
        state.apply_guild_leave(&config("player")).expect("leave");
        assert!(!state.guilds["guild-a"].members.contains_key("player"));
        assert!(state.actors["player"].player_organization_id.is_none());
        state
            .apply_guild_kick(&config("officer"), "member")
            .expect("kick");
        assert!(!state.guilds["guild-a"].members.contains_key("member"));
    }

    #[test]
    fn guild_transfer_preserves_explicit_officer_permissions_across_roundtrip() {
        let mut state = state_with_actors();
        add_actor(&mut state, "officer", "Officer");
        insert_guild(&mut state, "guild-a", "player", "Alpha");
        state
            .guilds
            .get_mut("guild-a")
            .expect("guild")
            .members
            .insert(
                "officer".to_owned(),
                member("officer", "Officer", AuthorityGuildRole::Member),
            );
        state
            .apply_guild_set_role(&config("player"), "officer", "officer")
            .expect("role");
        state
            .apply_guild_set_permissions(&config("player"), "officer", 9)
            .expect("permissions");

        state
            .apply_guild_transfer_leadership(&config("player"), "officer")
            .expect("promote");
        assert_eq!(
            state.guilds["guild-a"].members["officer"].role,
            AuthorityGuildRole::Leader
        );
        assert_eq!(state.guilds["guild-a"].members["officer"].permissions, 9);

        state
            .apply_guild_transfer_leadership(&config("officer"), "player")
            .expect("demote");
        assert_eq!(
            state.guilds["guild-a"].members["officer"].role,
            AuthorityGuildRole::Officer
        );
        assert_eq!(state.guilds["guild-a"].members["officer"].permissions, 9);
        assert_eq!(
            state
                .guild_view_for_observer(&config("player"))
                .roster
                .iter()
                .find(|entry| entry.actor_id == "officer")
                .expect("officer roster entry")
                .permissions,
            vec!["invite", "war"]
        );
        state.ensure_initial_skill_backup("officer");

        let checkpoint = state.export_checkpoint();
        let mut restored = state.clone();
        restored.restore_checkpoint(checkpoint).expect("import");
        assert_eq!(restored.guilds["guild-a"].members["officer"].permissions, 9);
        assert_eq!(
            restored
                .guild_view_for_observer(&config("player"))
                .roster
                .iter()
                .find(|entry| entry.actor_id == "officer")
                .expect("restored officer roster entry")
                .permissions,
            vec!["invite", "war"]
        );
    }

    #[test]
    fn guild_disband_cleans_membership_invites_and_war_references() {
        let mut state = state_with_actors();
        add_actor(&mut state, "leader-b", "Leader B");
        add_actor(&mut state, "outsider", "Outsider");
        insert_guild(&mut state, "guild-a", "player", "Alpha");
        insert_guild(&mut state, "guild-b", "leader-b", "Beta");
        state
            .apply_guild_invite(&config("player"), "outsider")
            .expect("invite");
        state
            .apply_guild_declare_war(&config("player"), "guild-b")
            .expect("war");
        assert!(!state.guild_invites.is_empty());
        state
            .apply_guild_disband(&config("player"))
            .expect("disband");
        assert!(!state.guilds.contains_key("guild-a"));
        assert!(state.guild_invites.is_empty());
        assert!(state.guilds["guild-b"].wars.is_empty());
        assert!(state.guilds["guild-b"].war_requests_in.is_empty());
        assert!(state.actors["player"].player_organization_id.is_none());
        assert!(state.actors["player"].player_organization_tag.is_none());
    }
    #[test]
    fn guild_export_import_roundtrip_keeps_hash_and_names() {
        let mut state = state_with_actors();
        insert_guild(&mut state, "guild-a", "player", "Dust Wardens");
        let before = state.stable_state_hash_hex();
        let blob = state.export_checkpoint();
        let mut restored = state.clone();
        restored.restore_checkpoint(blob).expect("import");
        assert_eq!(restored.stable_state_hash_hex(), before);
        assert_eq!(restored.guilds["guild-a"].name, "Dust Wardens");
    }
}

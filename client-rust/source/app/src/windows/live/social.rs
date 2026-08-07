use crate::windows::live::shared::{self, *};
use crate::windows::chrome::{self};
use crate::windows::{dim, label, Ctx, WindowAction, WindowModel};
use successor_engine_render::ui::UiBuilder;
use successor_net::ClientCommand;

pub fn guild(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    let metrics = pane.metrics;
    let leave = if model.pa.view.guild.is_some() {
        pane.reserve_footer()
    } else {
        None
    };
    if !model.pa.view.pending_invites.is_empty() {
        pane.section(ui, "INVITATIONS");
        let mut rows = pane.rows();
        for invite in &model.pa.view.pending_invites {
            let Some(mut row) = rows.next(ui) else { break };
            if row.quiet_action(ui, "DECLINE") {
                out.push(WindowAction::Command(ClientCommand::GuildDeclineInvite {
                    invite_id: invite.invite_id.clone(),
                }));
            }
            if row.action(ui, "ACCEPT") {
                out.push(WindowAction::Command(ClientCommand::GuildAcceptInvite {
                    invite_id: invite.invite_id.clone(),
                }));
            }
            row.value(ui, &invite.guild_tag);
            row.label(ui, &invite.guild_name);
        }
        pane.resume(&rows);
    }

    let Some(guild) = &model.pa.view.guild else {
        if !model.pa.gate.available {
            pane.denied(ui, &model.pa.gate.note);
            return;
        }
        let fee = crate::windows::model::GUILD_CHARTER_FEE_CREDITS;
        let affordable = model.pa.wallet_credits >= fee;
        pane.section(ui, "FOUND AN ASSOCIATION");
        pane.field(ui, "CHARTER FEE", &format!("{fee} CR"));
        if !affordable {
            pane.denied(ui, "INSUFFICIENT CREDITS");
        }
        let tag_w = 68.0f32.min(pane.w * 0.3);
        let name_w = (pane.w - tag_w - 8.0).max(0.0);
        shared::GUILD_NAME.with(|field| {
            ui.text_field(
                &mut field.borrow_mut(),
                pane.x,
                pane.y,
                name_w,
                chrome::FIELD_H,
                metrics.label_px,
                true,
                crate::hud::button_style(),
            );
        });
        shared::GUILD_TAG.with(|field| {
            ui.text_field(
                &mut field.borrow_mut(),
                pane.x + name_w + 8.0,
                pane.y,
                tag_w,
                chrome::FIELD_H,
                metrics.label_px,
                true,
                crate::hud::button_style(),
            );
        });
        let caption_y = pane.y + chrome::FIELD_H + 3.0;
        ui.text("NAME", pane.x, caption_y, metrics.caption_px, dim());
        ui.text(
            "TAG",
            pane.x + name_w + 8.0,
            caption_y,
            metrics.caption_px,
            dim(),
        );
        pane.y = caption_y + metrics.caption_px * 7.0 + 6.0;

        let named = shared::GUILD_NAME.with(|field| !field.borrow().text.trim().is_empty())
            && shared::GUILD_TAG.with(|field| !field.borrow().text.trim().is_empty());
        if named && affordable && pane.rail(ui, &["CREATE ASSOCIATION"]).is_some() {
            out.push(WindowAction::Command(ClientCommand::GuildCreate {
                name: shared::GUILD_NAME.with(|field| field.borrow().text.trim().to_string()),
                tag: shared::GUILD_TAG.with(|field| field.borrow().text.trim().to_string()),
                terminal_prop_id: model.pa.gate.prop_id.clone().unwrap_or_default(),
            }));
        }
        return;
    };

    pane.field_pair(
        ui,
        ("CHARTER", &guild.name),
        ("MEMBERS", &guild.member_count.to_string()),
    );
    pane.field(ui, "TAG", &guild.tag);
    if model.pa.has_permission("invite") {
        if let Some((actor_id, label)) = &model.pa.target {
            chrome::text_clipped(ui, label, pane.x, pane.y, metrics.caption_px, pane.w, dim());
            pane.y += metrics.caption_px * 7.0 + 3.0;
            if pane.rail(ui, &["INVITE SELECTED"]).is_some() {
                out.push(WindowAction::Command(ClientCommand::GuildInvite {
                    target_actor_id: actor_id.clone(),
                }));
            }
        }
    }

    pane.section(ui, "ROSTER");
    let mut rows = pane.rows();
    let mut any = false;
    for member in model.pa.view.roster.iter().take(6) {
        any = true;
        let Some(mut row) = rows.next(ui) else { break };
        if member.actor_id != model.pa.my_actor_id {
            if model.pa.has_permission("kick") && row.quiet_action(ui, "KICK") {
                out.push(WindowAction::Command(ClientCommand::GuildKick {
                    target_actor_id: member.actor_id.clone(),
                }));
            }
            if model.pa.is_leader() && row.action(ui, "LEAD") {
                out.push(WindowAction::Command(
                    ClientCommand::GuildTransferLeadership {
                        target_actor_id: member.actor_id.clone(),
                    },
                ));
            }
            if model.pa.has_permission("roles") {
                if row.action(ui, "PERMS") {
                    out.push(WindowAction::Command(ClientCommand::GuildSetPermissions {
                        target_actor_id: member.actor_id.clone(),
                        permissions: u8::MAX,
                    }));
                }
                let (label, role) = if member.role == "officer" {
                    ("MEMBER", "member")
                } else {
                    ("OFFICER", "officer")
                };
                if row.action(ui, label) {
                    out.push(WindowAction::Command(ClientCommand::GuildSetRole {
                        target_actor_id: member.actor_id.clone(),
                        role: role.into(),
                    }));
                }
            }
        }
        row.value(ui, &member.role.to_ascii_uppercase());
        if !member.online {
            row.value(ui, "OFFLINE");
        }
        row.label_tinted(ui, &member.name, if member.online { label() } else { dim() });
    }
    if !any {
        chrome::empty(ui, pane.x, rows.cursor(), "ROSTER EMPTY");
    }
    pane.resume(&rows);

    if model.pa.has_permission("war") {
        pane.section(ui, "WARS");
        let mut rows = pane.rows();
        let mut any = false;
        for war in &guild.wars {
            any = true;
            let Some(mut row) = rows.next(ui) else { break };
            let incoming = war.state == "incoming";
            if row.action(ui, if incoming { "ACCEPT" } else { "RESCIND" }) {
                let command = if incoming {
                    ClientCommand::GuildAcceptWar {
                        opposing_guild_id: war.opposing_guild_id.clone(),
                    }
                } else {
                    ClientCommand::GuildRescindWar {
                        opposing_guild_id: war.opposing_guild_id.clone(),
                    }
                };
                out.push(WindowAction::Command(command));
            }
            row.value(ui, &war.opposing_tag);
            row.label(ui, &war.opposing_name);
        }
        for candidate in model
            .pa
            .view
            .directory
            .iter()
            .filter(|entry| entry.id != guild.id)
            .take(2)
        {
            any = true;
            let Some(mut row) = rows.next(ui) else { break };
            if row.quiet_action(ui, "DECLARE") {
                out.push(WindowAction::Command(ClientCommand::GuildDeclareWar {
                    opposing_guild_id: candidate.id.clone(),
                }));
            }
            row.value(ui, &candidate.tag);
            row.label_tinted(ui, &candidate.name, dim());
        }
        if !any {
            chrome::empty(ui, pane.x, rows.cursor(), "NO WARS DECLARED");
        }
        pane.resume(&rows);
    }

    let leader = model.pa.is_leader();
    let labels: &[&str] = if leader {
        &["DISBAND ASSOCIATION"]
    } else {
        &["LEAVE ASSOCIATION"]
    };
    if pane.footer(ui, leave, labels).is_some() {
        let command = if leader {
            ClientCommand::GuildDisband {}
        } else {
            ClientCommand::GuildLeave {}
        };
        out.push(WindowAction::Command(command));
    }
}

pub fn group(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    if model.group.group.pending_invite.is_none()
        && model.group.group.members.is_empty()
        && model.group.group.group.is_none()
        && model.group.target.is_none()
        && model.group.duel.incoming_challenge.is_none()
        && model.group.duel.active_duel.is_none()
        && model.group.deathblow_target.is_none()
    {
        pane.empty(ui, "NO GROUP / SELECT A PLAYER");
        return;
    }
    if let Some(invite) = &model.group.group.pending_invite {
        pane.section(ui, "GROUP INVITE");
        pane.field(ui, "FROM", &invite.inviter_name);
        if let Some(index) = pane.rail(ui, &["ACCEPT", "DECLINE"]) {
            let command = if index == 0 {
                ClientCommand::GroupAccept {}
            } else {
                ClientCommand::GroupDecline {}
            };
            out.push(WindowAction::Command(command));
        }
    }
    if !model.group.group.members.is_empty() {
        pane.section(ui, "ROSTER");
        let mut rows = pane.rows();
        for member in &model.group.group.members {
            let Some(mut row) = rows.next(ui) else { break };
            if model.group.is_leader()
                && member.actor_id != model.group.my_actor_id
                && row.quiet_action(ui, "KICK")
            {
                out.push(WindowAction::Command(ClientCommand::GroupKick {
                    target_actor_id: member.actor_id.clone(),
                }));
            }
            row.value(
                ui,
                &format!(
                    "HP {:.0}/{:.0}",
                    member.vitals.health, member.max_vitals.health
                ),
            );
            if member.link_dead {
                row.value(ui, "LINK DEAD");
            }
            if member.is_leader {
                row.value(ui, "LEADER");
            }
            row.label_tinted(
                ui,
                &member.name,
                if member.life_state == "alive" {
                    label()
                } else {
                    dim()
                },
            );
        }
        pane.resume(&rows);
    }
    if model.group.group.group.is_some() {
        let leader = model.group.is_leader();
        let labels: &[&str] = if leader {
            &["DISBAND GROUP"]
        } else {
            &["LEAVE GROUP"]
        };
        if pane.rail(ui, labels).is_some() {
            let command = if leader {
                ClientCommand::GroupDisband {}
            } else {
                ClientCommand::GroupLeave {}
            };
            out.push(WindowAction::Command(command));
        }
    } else if let Some((actor_id, label, true)) = &model.group.target {
        pane.section(ui, "SELECTED PLAYER");
        pane.field(ui, "TARGET", label);
        let labels: &[&str] = if model.group.duel.active_duel.is_none() {
            &["GROUP INVITE", "DUEL"]
        } else {
            &["GROUP INVITE"]
        };
        if let Some(index) = pane.rail(ui, labels) {
            let command = if index == 0 {
                ClientCommand::GroupInvite {
                    target_actor_id: actor_id.clone(),
                }
            } else {
                ClientCommand::DuelChallenge {
                    target_actor_id: actor_id.clone(),
                }
            };
            out.push(WindowAction::Command(command));
        }
    } else if let Some((_, label, false)) = &model.group.target {
        pane.section(ui, "SELECTED PLAYER");
        pane.field(ui, "TARGET", label);
        pane.denied(ui, crate::windows::model::DENY_RANGE);
    }
    if let Some(challenge) = &model.group.duel.incoming_challenge {
        pane.section(ui, "DUEL CHALLENGE");
        pane.field(ui, "FROM", &challenge.other_name);
        if let Some(index) = pane.rail(ui, &["ACCEPT", "DECLINE"]) {
            let command = if index == 0 {
                ClientCommand::DuelAccept {}
            } else {
                ClientCommand::DuelDecline {}
            };
            out.push(WindowAction::Command(command));
        }
    }
    if let Some(duel) = &model.group.duel.active_duel {
        pane.section(ui, "DUEL ACTIVE");
        pane.field(ui, "OPPONENT", &duel.opponent_name);
        if pane.rail(ui, &["YIELD"]).is_some() {
            out.push(WindowAction::Command(ClientCommand::DuelYield {}));
        }
    }
    if let Some((actor_id, label)) = &model.group.deathblow_target {
        pane.field(ui, "DOWNED", label);
        if pane.rail(ui, &["DEATHBLOW"]).is_some() {
            out.push(WindowAction::Command(ClientCommand::Deathblow {
                target_actor_id: actor_id.clone(),
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hud::Icons;
    use crate::windows::model::{GroupMember, GroupVitals, GuildRosterEntry, GuildSummary};

    fn make_ctx(id: &str) -> Ctx {
        Ctx {
            spec: crate::windows::spec::surface(id).expect("surface spec"),
            rect: [10.0, 10.0, 400.0, 350.0],
            tab: 0,
        }
    }

    #[test]
    fn guild_roster_renders_members_and_actions() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut model = WindowModel::sample();

        model.pa.my_actor_id = "actor-me".into();
        model.pa.view.guild = Some(GuildSummary {
            id: "pa-1".into(),
            name: "Syndicate".into(),
            tag: "SYN".into(),
            leader_actor_id: "actor-me".into(),
            member_count: 2,
            ..Default::default()
        });
        model.pa.view.roster.push(GuildRosterEntry {
            actor_id: "actor-other".into(),
            name: "Vader".into(),
            role: "officer".into(),
            online: true,
            ..Default::default()
        });

        let mut out = Vec::new();
        ui.begin(1280, 720);
        guild(&mut ui, make_ctx("pa"), &model, &mut out);

        assert!(ui.quads > 0, "guild must render roster and header");
    }

    #[test]
    fn group_roster_renders_members_and_vitals() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut model = WindowModel::sample();

        model.group.my_actor_id = "actor-me".into();
        model.group.group.members.push(GroupMember {
            actor_id: "actor-other".into(),
            name: "Han".into(),
            area_id: "dustgate".into(),
            is_leader: false,
            link_dead: false,
            life_state: "alive".into(),
            vitals: GroupVitals {
                health: 100.0,
                action: 100.0,
            },
            max_vitals: GroupVitals {
                health: 100.0,
                action: 100.0,
            },
        });

        let mut out = Vec::new();
        ui.begin(1280, 720);
        group(&mut ui, make_ctx("group"), &model, &mut out);

        assert!(ui.quads > 0, "group must render member roster");
    }
}

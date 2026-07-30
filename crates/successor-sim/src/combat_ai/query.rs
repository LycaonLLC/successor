use super::affordance::PrimitiveCell;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PrimitiveQueryActor {
    pub(crate) id: &'static str,
    pub(crate) cell: PrimitiveCell,
}

impl PrimitiveQueryActor {
    pub(crate) const fn new(id: &'static str, cell: PrimitiveCell) -> Self {
        Self { id, cell }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PrimitiveQueryKind {
    Advance {
        target: PrimitiveCell,
        threat: PrimitiveCell,
    },
    ReachableMove {
        target: PrimitiveCell,
        reason: &'static str,
    },
    NearestReachable {
        requested: PrimitiveCell,
        max_radius: i32,
    },
    Cover {
        threat: PrimitiveCell,
        reason: &'static str,
    },
    LateralEvasion {
        threat: PrimitiveCell,
    },
    CrowdedCover {
        threat: PrimitiveCell,
    },
}

impl PrimitiveQueryKind {
    pub(crate) const fn label(&self) -> &'static str {
        match self {
            Self::Advance { .. } => "advance",
            Self::ReachableMove { .. } => "reachable_move",
            Self::NearestReachable { .. } => "nearest_reachable",
            Self::Cover { .. } => "cover",
            Self::LateralEvasion { .. } => "lateral_evasion",
            Self::CrowdedCover { .. } => "crowded_cover",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PrimitiveTacticalQuery {
    pub(crate) actors: Vec<PrimitiveQueryActor>,
    pub(crate) kind: PrimitiveQueryKind,
}

impl PrimitiveTacticalQuery {
    pub(crate) fn advance(
        actor_id: &'static str,
        actor: PrimitiveCell,
        target: PrimitiveCell,
        threat: PrimitiveCell,
    ) -> Self {
        Self::single(
            actor_id,
            actor,
            PrimitiveQueryKind::Advance { target, threat },
        )
    }

    pub(crate) fn reachable_move(
        actor_id: &'static str,
        actor: PrimitiveCell,
        target: PrimitiveCell,
        reason: &'static str,
    ) -> Self {
        Self::single(
            actor_id,
            actor,
            PrimitiveQueryKind::ReachableMove { target, reason },
        )
    }

    pub(crate) fn nearest_reachable(
        actor_id: &'static str,
        actor: PrimitiveCell,
        requested: PrimitiveCell,
        max_radius: i32,
    ) -> Self {
        Self::single(
            actor_id,
            actor,
            PrimitiveQueryKind::NearestReachable {
                requested,
                max_radius,
            },
        )
    }

    pub(crate) fn cover(
        actor_id: &'static str,
        actor: PrimitiveCell,
        threat: PrimitiveCell,
        reason: &'static str,
    ) -> Self {
        Self::single(
            actor_id,
            actor,
            PrimitiveQueryKind::Cover { threat, reason },
        )
    }

    pub(crate) fn lateral_evasion(
        actor_id: &'static str,
        actor: PrimitiveCell,
        threat: PrimitiveCell,
    ) -> Self {
        Self::single(
            actor_id,
            actor,
            PrimitiveQueryKind::LateralEvasion { threat },
        )
    }

    pub(crate) fn crowded_cover(actors: Vec<PrimitiveQueryActor>, threat: PrimitiveCell) -> Self {
        Self {
            actors,
            kind: PrimitiveQueryKind::CrowdedCover { threat },
        }
    }

    pub(crate) fn primary_actor(&self) -> Option<PrimitiveQueryActor> {
        self.actors.first().copied()
    }

    fn single(actor_id: &'static str, actor: PrimitiveCell, kind: PrimitiveQueryKind) -> Self {
        Self {
            actors: vec![PrimitiveQueryActor::new(actor_id, actor)],
            kind,
        }
    }
}

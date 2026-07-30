//! Small integer grid primitives used by the first Successor simulation slices.

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ZoneId(pub u32);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Level(pub i32);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CellCoord2 {
    pub x: i32,
    pub y: i32,
}

impl CellCoord2 {
    pub const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }

    pub const fn offset(self, delta: CellDelta2) -> Self {
        Self {
            x: self.x + delta.dx,
            y: self.y + delta.dy,
        }
    }

    pub fn manhattan_distance(self, other: Self) -> u32 {
        self.x.abs_diff(other.x) + self.y.abs_diff(other.y)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CellDelta2 {
    pub dx: i32,
    pub dy: i32,
}

impl CellDelta2 {
    pub const fn new(dx: i32, dy: i32) -> Self {
        Self { dx, dy }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ZoneCell {
    pub zone: ZoneId,
    pub level: Level,
    pub coord: CellCoord2,
}

impl ZoneCell {
    pub const fn new(zone: ZoneId, level: Level, coord: CellCoord2) -> Self {
        Self { zone, level, coord }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellAabb2 {
    pub min: CellCoord2,
    pub max: CellCoord2,
}

impl CellAabb2 {
    pub const fn new(min: CellCoord2, max: CellCoord2) -> Self {
        Self { min, max }
    }

    pub fn normalized(self) -> Self {
        Self {
            min: CellCoord2::new(self.min.x.min(self.max.x), self.min.y.min(self.max.y)),
            max: CellCoord2::new(self.min.x.max(self.max.x), self.min.y.max(self.max.y)),
        }
    }

    pub fn contains(self, coord: CellCoord2) -> bool {
        let n = self.normalized();
        coord.x >= n.min.x && coord.x <= n.max.x && coord.y >= n.min.y && coord.y <= n.max.y
    }
}

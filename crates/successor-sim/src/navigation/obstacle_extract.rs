use super::nav_provider::NavCell;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NavObstacleRect {
    pub(crate) min: NavCell,
    pub(crate) max: NavCell,
}

impl NavObstacleRect {
    pub(crate) fn cell_count(self) -> u32 {
        let width = self.max.x.saturating_sub(self.min.x).saturating_add(1);
        let height = self.max.y.saturating_sub(self.min.y).saturating_add(1);
        u32::try_from(width.saturating_mul(height)).unwrap_or(u32::MAX)
    }

    #[cfg(test)]
    pub(crate) fn contains(self, cell: NavCell) -> bool {
        cell.x >= self.min.x && cell.x <= self.max.x && cell.y >= self.min.y && cell.y <= self.max.y
    }
}

pub(crate) fn extract_blocked_cell_rects<I>(blocked_cells: I) -> Vec<NavObstacleRect>
where
    I: IntoIterator<Item = NavCell>,
{
    let mut remaining = blocked_cells.into_iter().collect::<BTreeSet<_>>();
    let mut rects = Vec::new();

    while !remaining.is_empty() {
        let start = *remaining
            .iter()
            .min_by_key(|cell| (cell.y, cell.x))
            .expect("remaining is non-empty");
        let max_x = horizontal_run_end(&remaining, start);
        let max_y = vertical_rect_end(&remaining, start, max_x);
        let rect = NavObstacleRect {
            min: start,
            max: NavCell::new(max_x, max_y),
        };
        remove_rect_cells(&mut remaining, rect);
        rects.push(rect);
    }

    rects
}

fn horizontal_run_end(blocked: &BTreeSet<NavCell>, start: NavCell) -> i32 {
    let mut x = start.x;
    while blocked.contains(&NavCell::new(x.saturating_add(1), start.y)) {
        x = x.saturating_add(1);
    }
    x
}

fn vertical_rect_end(blocked: &BTreeSet<NavCell>, start: NavCell, max_x: i32) -> i32 {
    let mut y = start.y;
    'rows: loop {
        let next_y = y.saturating_add(1);
        for x in start.x..=max_x {
            if !blocked.contains(&NavCell::new(x, next_y)) {
                break 'rows;
            }
        }
        y = next_y;
    }
    y
}

fn remove_rect_cells(blocked: &mut BTreeSet<NavCell>, rect: NavObstacleRect) {
    for y in rect.min.y..=rect.max.y {
        for x in rect.min.x..=rect.max.x {
            blocked.remove(&NavCell::new(x, y));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_single_vertical_wall_as_one_rect() {
        let rects = extract_blocked_cell_rects((3..=8).map(|y| NavCell::new(8, y)));
        assert_eq!(
            rects,
            vec![NavObstacleRect {
                min: NavCell::new(8, 3),
                max: NavCell::new(8, 8),
            }]
        );
        assert_eq!(rects[0].cell_count(), 6);
        assert!(rects[0].contains(NavCell::new(8, 6)));
    }

    #[test]
    fn extracts_l_shape_without_filling_open_corner() {
        let vertical = (3..=6).map(|y| NavCell::new(9, y));
        let horizontal = (10..=12).map(|x| NavCell::new(x, 6));
        let rects = extract_blocked_cell_rects(vertical.chain(horizontal));
        assert_eq!(
            rects,
            vec![
                NavObstacleRect {
                    min: NavCell::new(9, 3),
                    max: NavCell::new(9, 6),
                },
                NavObstacleRect {
                    min: NavCell::new(10, 6),
                    max: NavCell::new(12, 6),
                },
            ]
        );
        assert!(!rects.iter().any(|rect| rect.contains(NavCell::new(10, 5))));
    }

    #[test]
    fn extracts_disconnected_rectangles_in_stable_scan_order() {
        let cells = [
            NavCell::new(4, 4),
            NavCell::new(5, 4),
            NavCell::new(4, 5),
            NavCell::new(5, 5),
            NavCell::new(9, 2),
            NavCell::new(9, 3),
        ];
        let rects = extract_blocked_cell_rects(cells);
        assert_eq!(
            rects,
            vec![
                NavObstacleRect {
                    min: NavCell::new(9, 2),
                    max: NavCell::new(9, 3),
                },
                NavObstacleRect {
                    min: NavCell::new(4, 4),
                    max: NavCell::new(5, 5),
                },
            ]
        );
    }
}

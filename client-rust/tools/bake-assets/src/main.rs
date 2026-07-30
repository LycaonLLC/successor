//! Rasterizes the `client-3d` SVG icon vocabulary (`src/ui/icons.ts`, viewBox
//! 0 0 24, stroke-width 1.5, round caps/joins) into a committed A8 atlas the
//! Rust client UI samples. Distance-field stroking: every primitive (rect/
//! circle/ellipse/path incl. arcs + cubics) flattens to polylines, then each
//! output pixel takes coverage from its distance to the nearest segment — which
//! yields round caps and joins for free with cheap anti-aliasing.
//!
//! Run: `cargo run --release --manifest-path tools/bake-assets/Cargo.toml`
//! Outputs (committed): `source/app/assets/ui/icons.a8` + `icons.json`.

use std::f32::consts::PI;
use std::fs;
use std::path::Path;

const VIEWBOX: f32 = 24.0;
const STROKE_HALF: f32 = 0.75; // stroke-width 1.5 / 2
const CELL: usize = 32;
const COLS: usize = 8;

type Pt = [f32; 2];
type Polyline = Vec<Pt>;

fn main() {
    // Resolve paths relative to the client-rust workspace root (two levels up
    // from tools/bake-assets/).
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let icons_ts = root.join("../client-3d/src/ui/icons.ts");
    let src = fs::read_to_string(&icons_ts)
        .unwrap_or_else(|e| panic!("read {}: {e}", icons_ts.display()));

    let mut entries = extract_icons(&src);
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    println!("baking {} icons", entries.len());

    let rows = entries.len().div_ceil(COLS);
    let aw = COLS * CELL;
    let ah = rows * CELL;
    let mut atlas = vec![0u8; aw * ah];

    let mut json_icons = String::new();
    for (k, (id, svg)) in entries.iter().enumerate() {
        let polylines = parse_svg(svg);
        let cell = rasterize(&polylines, CELL);
        let (col, row) = (k % COLS, k / COLS);
        blit(&mut atlas, aw, &cell, CELL, col * CELL, row * CELL);
        if k > 0 {
            json_icons.push(',');
        }
        json_icons.push_str(&format!(
            "{{\"id\":\"{id}\",\"col\":{col},\"row\":{row}}}"
        ));
    }

    let out_dir = root.join("source/app/assets/ui");
    fs::create_dir_all(&out_dir).unwrap();
    fs::write(out_dir.join("icons.a8"), &atlas).unwrap();
    let json = format!(
        "{{\"cell\":{CELL},\"cols\":{COLS},\"width\":{aw},\"height\":{ah},\"icons\":[{json_icons}]}}"
    );
    fs::write(out_dir.join("icons.json"), json).unwrap();
    println!("wrote {}/icons.a8 ({aw}x{ah}) + icons.json", out_dir.display());
}

// ── icons.ts extraction ─────────────────────────────────────────────────────

/// Extract `(id, inner-svg)` for each `UI_ICONS` entry. `inner-svg` is the
/// concatenation of the single-quoted string literals passed to `icon(...)`.
fn extract_icons(src: &str) -> Vec<(String, String)> {
    let b = src.as_bytes();
    let mut out = Vec::new();
    let needle = b"icon(";
    let mut i = 0;
    while i + needle.len() <= b.len() {
        if &b[i..i + needle.len()] == needle {
            if let Some(id) = key_before(b, i) {
                let (svg, end) = collect_arg(b, i + needle.len());
                out.push((id, svg));
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Walk backward from the `i` (`icon(` start) over `whitespace : whitespace` to
/// read the preceding key token (quoted or bare identifier).
fn key_before(b: &[u8], i: usize) -> Option<String> {
    let mut j = i;
    while j > 0 && b[j - 1].is_ascii_whitespace() {
        j -= 1;
    }
    if j == 0 || b[j - 1] != b':' {
        return None;
    }
    j -= 1;
    while j > 0 && b[j - 1].is_ascii_whitespace() {
        j -= 1;
    }
    if j == 0 {
        return None;
    }
    if b[j - 1] == b'"' {
        let end = j - 1;
        let mut k = end;
        while k > 0 && b[k - 1] != b'"' {
            k -= 1;
        }
        Some(String::from_utf8_lossy(&b[k..end]).into_owned())
    } else {
        let end = j;
        let mut k = end;
        while k > 0 && (b[k - 1].is_ascii_alphanumeric() || b[k - 1] == b'-') {
            k -= 1;
        }
        if k == end {
            None
        } else {
            Some(String::from_utf8_lossy(&b[k..end]).into_owned())
        }
    }
}

/// From just after `icon(`, gather the concatenated single-quoted literals until
/// the matching close paren. Returns the joined string and the index past `)`.
fn collect_arg(b: &[u8], mut i: usize) -> (String, usize) {
    let mut svg = String::new();
    while i < b.len() {
        match b[i] {
            b')' => {
                i += 1;
                break;
            }
            b'\'' => {
                i += 1;
                let start = i;
                while i < b.len() && b[i] != b'\'' {
                    i += 1;
                }
                svg.push_str(&String::from_utf8_lossy(&b[start..i]));
                i += 1;
            }
            _ => i += 1,
        }
    }
    (svg, i)
}

// ── SVG primitive parsing → polylines ───────────────────────────────────────

fn parse_svg(svg: &str) -> Vec<Polyline> {
    let mut lines = Vec::new();
    let b = svg.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'<' {
            let (tag, attrs, next) = read_tag(b, i);
            i = next;
            match tag.as_str() {
                "path" => {
                    if let Some(d) = attr(&attrs, "d") {
                        parse_path(&d, &mut lines);
                    }
                }
                "rect" => lines.extend(rect_polyline(&attrs)),
                "circle" => {
                    let cx = attr_f(&attrs, "cx");
                    let cy = attr_f(&attrs, "cy");
                    let r = attr_f(&attrs, "r");
                    lines.push(ellipse_polyline(cx, cy, r, r));
                }
                "ellipse" => {
                    let cx = attr_f(&attrs, "cx");
                    let cy = attr_f(&attrs, "cy");
                    let rx = attr_f(&attrs, "rx");
                    let ry = attr_f(&attrs, "ry");
                    lines.push(ellipse_polyline(cx, cy, rx, ry));
                }
                _ => {}
            }
        } else {
            i += 1;
        }
    }
    lines
}

fn read_tag(b: &[u8], start: usize) -> (String, Vec<(String, String)>, usize) {
    let mut i = start + 1;
    let name_start = i;
    while i < b.len() && (b[i].is_ascii_alphanumeric()) {
        i += 1;
    }
    let tag = String::from_utf8_lossy(&b[name_start..i]).into_owned();
    let mut attrs = Vec::new();
    while i < b.len() && b[i] != b'>' {
        if b[i].is_ascii_alphabetic() {
            let ks = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'-') {
                i += 1;
            }
            let key = String::from_utf8_lossy(&b[ks..i]).into_owned();
            // skip = and quote
            while i < b.len() && b[i] != b'"' && b[i] != b'>' {
                i += 1;
            }
            if i < b.len() && b[i] == b'"' {
                i += 1;
                let vs = i;
                while i < b.len() && b[i] != b'"' {
                    i += 1;
                }
                let val = String::from_utf8_lossy(&b[vs..i]).into_owned();
                i += 1;
                attrs.push((key, val));
            }
        } else {
            i += 1;
        }
    }
    if i < b.len() {
        i += 1; // past '>'
    }
    (tag, attrs, i)
}

fn attr(attrs: &[(String, String)], k: &str) -> Option<String> {
    attrs.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone())
}
fn attr_f(attrs: &[(String, String)], k: &str) -> f32 {
    attr(attrs, k).and_then(|v| v.parse().ok()).unwrap_or(0.0)
}

fn rect_polyline(attrs: &[(String, String)]) -> Vec<Polyline> {
    let x = attr_f(attrs, "x");
    let y = attr_f(attrs, "y");
    let w = attr_f(attrs, "width");
    let h = attr_f(attrs, "height");
    let rx = attr(attrs, "rx").and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let ry = attr(attrs, "ry").and_then(|v| v.parse().ok()).unwrap_or(rx);
    let mut p = Vec::new();
    if rx <= 0.0 && ry <= 0.0 {
        p.push([x, y]);
        p.push([x + w, y]);
        p.push([x + w, y + h]);
        p.push([x, y + h]);
        p.push([x, y]);
        return vec![p];
    }
    let arc = |p: &mut Vec<Pt>, cx: f32, cy: f32, a0: f32, a1: f32| {
        let n = 8;
        for i in 0..=n {
            let t = a0 + (a1 - a0) * i as f32 / n as f32;
            p.push([cx + rx * t.cos(), cy + ry * t.sin()]);
        }
    };
    p.push([x + rx, y]);
    p.push([x + w - rx, y]);
    arc(&mut p, x + w - rx, y + ry, -PI / 2.0, 0.0);
    p.push([x + w, y + h - ry]);
    arc(&mut p, x + w - rx, y + h - ry, 0.0, PI / 2.0);
    p.push([x + rx, y + h]);
    arc(&mut p, x + rx, y + h - ry, PI / 2.0, PI);
    p.push([x, y + ry]);
    arc(&mut p, x + rx, y + ry, PI, 1.5 * PI);
    vec![p]
}

fn ellipse_polyline(cx: f32, cy: f32, rx: f32, ry: f32) -> Polyline {
    let n = 48;
    let mut p = Vec::with_capacity(n + 1);
    for i in 0..=n {
        let t = 2.0 * PI * i as f32 / n as f32;
        p.push([cx + rx * t.cos(), cy + ry * t.sin()]);
    }
    p
}

// ── SVG path `d` → polylines ────────────────────────────────────────────────

struct Cursor<'a> {
    b: &'a [u8],
    i: usize,
}
impl<'a> Cursor<'a> {
    fn skip_sep(&mut self) {
        while self.i < self.b.len() {
            let c = self.b[self.i];
            if c == b',' || c.is_ascii_whitespace() {
                self.i += 1;
            } else {
                break;
            }
        }
    }
    fn peek_cmd(&mut self) -> Option<u8> {
        self.skip_sep();
        if self.i < self.b.len() && self.b[self.i].is_ascii_alphabetic() {
            let c = self.b[self.i];
            self.i += 1;
            Some(c)
        } else {
            None
        }
    }
    fn num(&mut self) -> Option<f32> {
        self.skip_sep();
        let start = self.i;
        if self.i < self.b.len() && (self.b[self.i] == b'-' || self.b[self.i] == b'+') {
            self.i += 1;
        }
        let mut seen = false;
        while self.i < self.b.len() && self.b[self.i].is_ascii_digit() {
            self.i += 1;
            seen = true;
        }
        if self.i < self.b.len() && self.b[self.i] == b'.' {
            self.i += 1;
            while self.i < self.b.len() && self.b[self.i].is_ascii_digit() {
                self.i += 1;
                seen = true;
            }
        }
        if seen && self.i < self.b.len() && (self.b[self.i] == b'e' || self.b[self.i] == b'E') {
            self.i += 1;
            if self.i < self.b.len() && (self.b[self.i] == b'-' || self.b[self.i] == b'+') {
                self.i += 1;
            }
            while self.i < self.b.len() && self.b[self.i].is_ascii_digit() {
                self.i += 1;
            }
        }
        if !seen {
            self.i = start;
            return None;
        }
        std::str::from_utf8(&self.b[start..self.i]).ok()?.parse().ok()
    }
    fn has_num(&mut self) -> bool {
        self.skip_sep();
        self.i < self.b.len()
            && (self.b[self.i].is_ascii_digit()
                || self.b[self.i] == b'-'
                || self.b[self.i] == b'+'
                || self.b[self.i] == b'.')
    }
}

fn parse_path(d: &str, out: &mut Vec<Polyline>) {
    let mut c = Cursor { b: d.as_bytes(), i: 0 };
    let mut cur: Pt = [0.0, 0.0];
    let mut start: Pt = [0.0, 0.0];
    let mut poly: Polyline = Vec::new();
    let mut cmd = 0u8;

    macro_rules! flush {
        () => {
            if poly.len() > 1 {
                out.push(std::mem::take(&mut poly));
            } else {
                poly.clear();
            }
        };
    }

    loop {
        let next = c.peek_cmd();
        match next {
            Some(k) => cmd = k,
            None => {
                if !c.has_num() {
                    break;
                }
                // implicit repeat: M/m repeats as L/l
                cmd = match cmd {
                    b'M' => b'L',
                    b'm' => b'l',
                    other => other,
                };
            }
        }
        let rel = cmd.is_ascii_lowercase();
        match cmd.to_ascii_uppercase() {
            b'M' => {
                let (x, y) = (c.num().unwrap(), c.num().unwrap());
                flush!();
                cur = if rel { [cur[0] + x, cur[1] + y] } else { [x, y] };
                start = cur;
                poly.push(cur);
            }
            b'L' => {
                let (x, y) = (c.num().unwrap(), c.num().unwrap());
                cur = if rel { [cur[0] + x, cur[1] + y] } else { [x, y] };
                poly.push(cur);
            }
            b'H' => {
                let x = c.num().unwrap();
                cur = if rel { [cur[0] + x, cur[1]] } else { [x, cur[1]] };
                poly.push(cur);
            }
            b'V' => {
                let y = c.num().unwrap();
                cur = if rel { [cur[0], cur[1] + y] } else { [cur[0], y] };
                poly.push(cur);
            }
            b'C' => {
                let n: Vec<f32> = (0..6).map(|_| c.num().unwrap()).collect();
                let (p1, p2, p3) = if rel {
                    (
                        [cur[0] + n[0], cur[1] + n[1]],
                        [cur[0] + n[2], cur[1] + n[3]],
                        [cur[0] + n[4], cur[1] + n[5]],
                    )
                } else {
                    ([n[0], n[1]], [n[2], n[3]], [n[4], n[5]])
                };
                cubic(cur, p1, p2, p3, &mut poly);
                cur = p3;
            }
            b'Q' => {
                let n: Vec<f32> = (0..4).map(|_| c.num().unwrap()).collect();
                let (p1, p2) = if rel {
                    ([cur[0] + n[0], cur[1] + n[1]], [cur[0] + n[2], cur[1] + n[3]])
                } else {
                    ([n[0], n[1]], [n[2], n[3]])
                };
                quad(cur, p1, p2, &mut poly);
                cur = p2;
            }
            b'A' => {
                let rx = c.num().unwrap();
                let ry = c.num().unwrap();
                let rot = c.num().unwrap();
                let large = c.num().unwrap() != 0.0;
                let sweep = c.num().unwrap() != 0.0;
                let (ex, ey) = (c.num().unwrap(), c.num().unwrap());
                let end = if rel { [cur[0] + ex, cur[1] + ey] } else { [ex, ey] };
                arc_to(cur, rx, ry, rot, large, sweep, end, &mut poly);
                cur = end;
            }
            b'Z' => {
                poly.push(start);
                flush!();
                cur = start;
            }
            _ => {
                // Unknown command: consume a number to avoid an infinite loop.
                let _ = c.num();
            }
        }
    }
    flush!();
}

fn cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, out: &mut Polyline) {
    let n = 16;
    for i in 1..=n {
        let t = i as f32 / n as f32;
        let u = 1.0 - t;
        let x = u * u * u * p0[0] + 3.0 * u * u * t * p1[0] + 3.0 * u * t * t * p2[0] + t * t * t * p3[0];
        let y = u * u * u * p0[1] + 3.0 * u * u * t * p1[1] + 3.0 * u * t * t * p2[1] + t * t * t * p3[1];
        out.push([x, y]);
    }
}
fn quad(p0: Pt, p1: Pt, p2: Pt, out: &mut Polyline) {
    let n = 14;
    for i in 1..=n {
        let t = i as f32 / n as f32;
        let u = 1.0 - t;
        let x = u * u * p0[0] + 2.0 * u * t * p1[0] + t * t * p2[0];
        let y = u * u * p0[1] + 2.0 * u * t * p1[1] + t * t * p2[1];
        out.push([x, y]);
    }
}

/// SVG elliptical-arc endpoint parametrization (spec F.6.5), sampled to a
/// polyline appended after the current point.
#[allow(clippy::too_many_arguments)]
fn arc_to(p0: Pt, mut rx: f32, mut ry: f32, rot_deg: f32, large: bool, sweep: bool, p1: Pt, out: &mut Polyline) {
    if rx == 0.0 || ry == 0.0 || (p0[0] == p1[0] && p0[1] == p1[1]) {
        out.push(p1);
        return;
    }
    rx = rx.abs();
    ry = ry.abs();
    let phi = rot_deg * PI / 180.0;
    let (cp, sp) = (phi.cos(), phi.sin());
    let dx = (p0[0] - p1[0]) / 2.0;
    let dy = (p0[1] - p1[1]) / 2.0;
    let x1 = cp * dx + sp * dy;
    let y1 = -sp * dx + cp * dy;
    // Correct out-of-range radii.
    let lam = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);
    if lam > 1.0 {
        let s = lam.sqrt();
        rx *= s;
        ry *= s;
    }
    let sign = if large != sweep { 1.0 } else { -1.0 };
    let num = (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1).max(0.0);
    let den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let co = sign * (num / den).sqrt();
    let cx1 = co * rx * y1 / ry;
    let cy1 = -co * ry * x1 / rx;
    let cx = cp * cx1 - sp * cy1 + (p0[0] + p1[0]) / 2.0;
    let cy = sp * cx1 + cp * cy1 + (p0[1] + p1[1]) / 2.0;
    let ang = |ux: f32, uy: f32, vx: f32, vy: f32| -> f32 {
        let dot = ux * vx + uy * vy;
        let len = (ux * ux + uy * uy).sqrt() * (vx * vx + vy * vy).sqrt();
        let mut a = (dot / len).clamp(-1.0, 1.0).acos();
        if ux * vy - uy * vx < 0.0 {
            a = -a;
        }
        a
    };
    let theta1 = ang(1.0, 0.0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let mut dtheta = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if !sweep && dtheta > 0.0 {
        dtheta -= 2.0 * PI;
    } else if sweep && dtheta < 0.0 {
        dtheta += 2.0 * PI;
    }
    let steps = (dtheta.abs() / (PI / 16.0)).ceil().max(2.0) as usize;
    for i in 1..=steps {
        let t = theta1 + dtheta * i as f32 / steps as f32;
        let (ct, st) = (t.cos(), t.sin());
        let ex = cp * (rx * ct) - sp * (ry * st) + cx;
        let ey = sp * (rx * ct) + cp * (ry * st) + cy;
        out.push([ex, ey]);
    }
}

// ── distance-field rasterization ────────────────────────────────────────────

fn rasterize(polylines: &[Polyline], size: usize) -> Vec<u8> {
    let mut out = vec![0u8; size * size];
    let scale = VIEWBOX / size as f32;
    let aa = 0.6 * scale;
    for iy in 0..size {
        for ix in 0..size {
            let px = (ix as f32 + 0.5) * scale;
            let py = (iy as f32 + 0.5) * scale;
            let mut best = f32::MAX;
            for line in polylines {
                for w in line.windows(2) {
                    let d = dist_seg(px, py, w[0], w[1]);
                    if d < best {
                        best = d;
                    }
                }
            }
            let cov = ((STROKE_HALF + aa - best) / (2.0 * aa)).clamp(0.0, 1.0);
            out[iy * size + ix] = (cov * 255.0 + 0.5) as u8;
        }
    }
    out
}

fn dist_seg(px: f32, py: f32, a: Pt, b: Pt) -> f32 {
    let (vx, vy) = (b[0] - a[0], b[1] - a[1]);
    let (wx, wy) = (px - a[0], py - a[1]);
    let len2 = vx * vx + vy * vy;
    let t = if len2 <= 1e-9 { 0.0 } else { ((wx * vx + wy * vy) / len2).clamp(0.0, 1.0) };
    let cx = a[0] + t * vx;
    let cy = a[1] + t * vy;
    let (dx, dy) = (px - cx, py - cy);
    (dx * dx + dy * dy).sqrt()
}

fn blit(atlas: &mut [u8], aw: usize, cell: &[u8], cs: usize, ox: usize, oy: usize) {
    for y in 0..cs {
        for x in 0..cs {
            atlas[(oy + y) * aw + ox + x] = cell[y * cs + x];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_and_rasterizes_close_icon() {
        // The 'close' X is two crossing strokes: a rasterized cell must have
        // lit pixels near the center and the diagonal must be non-empty.
        let svg = "<path d=\"M6.75 6.75l10.5 10.5M17.25 6.75l-10.5 10.5\"/>";
        let lines = parse_svg(svg);
        assert_eq!(lines.len(), 2, "two strokes");
        let cell = rasterize(&lines, CELL);
        let lit = cell.iter().filter(|&&a| a > 40).count();
        assert!(lit > 20, "close icon has visible strokes, got {lit}");
        // center pixel should be near a stroke (the X crosses at 12,12 -> center)
        let c = cell[(CELL / 2) * CELL + CELL / 2];
        assert!(c > 60, "center of X is lit, got {c}");
    }

    #[test]
    fn parses_arc_command() {
        // reload uses an arc; ensure it yields a non-trivial polyline.
        let svg = "<path d=\"M19.5 12a7.5 7.5 0 1 1-2.6-5.7\"/>";
        let lines = parse_svg(svg);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].len() > 8, "arc flattened to many points");
    }

    #[test]
    fn key_extraction_handles_quoted_and_bare() {
        let src = "bank: icon('<circle cx=\"1\" cy=\"1\" r=\"1\"/>'), \"clone-facility\": icon('<path d=\"M0 0L1 1\"/>'),";
        let e = extract_icons(src);
        assert!(e.iter().any(|(id, _)| id == "bank"));
        assert!(e.iter().any(|(id, _)| id == "clone-facility"));
    }
}

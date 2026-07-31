//! Hand-rolled `no_std` JSON value, parser, and writer.
//!
//! `serde_json` is not `no_std`-friendly, and the size gate forbids
//! `core::fmt`, so this is a small recursive-descent parser plus a string
//! builder. Modeled on the voxel engine's `json.rs`. The float writer is
//! adaptive: it emits the fewest fractional digits (0..=9) whose value
//! round-trips back to the same `f32`, which covers all client prefab/manifest
//! data (positions, colors, scales).

use alloc::string::String;
use alloc::vec::Vec;

#[derive(Clone, PartialEq, Debug)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum JsonError {
    Eof,
    Unexpected,
    BadEscape,
    BadNumber,
}

impl Json {
    pub fn parse(input: &str) -> Result<Json, JsonError> {
        let mut p = Parser {
            bytes: input.as_bytes(),
            pos: 0,
        };
        p.skip_ws();
        let v = p.parse_value()?;
        p.skip_ws();
        if p.pos != p.bytes.len() {
            return Err(JsonError::Unexpected);
        }
        Ok(v)
    }

    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_f32(&self) -> Option<f32> {
        self.as_f64().map(|n| n as f32)
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Json::Num(n) => Some(*n as i64),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Arr(a) => Some(a.as_slice()),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(String, Json)]> {
        match self {
            Json::Obj(o) => Some(o.as_slice()),
            _ => None,
        }
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while let Some(c) = self.peek() {
            if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn parse_value(&mut self) -> Result<Json, JsonError> {
        match self.peek().ok_or(JsonError::Eof)? {
            b'{' => self.parse_object(),
            b'[' => self.parse_array(),
            b'"' => Ok(Json::Str(self.parse_string()?)),
            b't' => self.parse_lit("true", Json::Bool(true)),
            b'f' => self.parse_lit("false", Json::Bool(false)),
            b'n' => self.parse_lit("null", Json::Null),
            b'-' | b'0'..=b'9' => self.parse_number(),
            _ => Err(JsonError::Unexpected),
        }
    }

    fn parse_lit(&mut self, lit: &str, val: Json) -> Result<Json, JsonError> {
        let end = self.pos + lit.len();
        if end <= self.bytes.len() && &self.bytes[self.pos..end] == lit.as_bytes() {
            self.pos = end;
            Ok(val)
        } else {
            Err(JsonError::Unexpected)
        }
    }

    fn parse_object(&mut self) -> Result<Json, JsonError> {
        self.pos += 1; // '{'
        let mut fields = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Json::Obj(fields));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err(JsonError::Unexpected);
            }
            let key = self.parse_string()?;
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err(JsonError::Unexpected);
            }
            self.pos += 1;
            self.skip_ws();
            let value = self.parse_value()?;
            fields.push((key, value));
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Json::Obj(fields));
                }
                _ => return Err(JsonError::Unexpected),
            }
        }
    }

    fn parse_array(&mut self) -> Result<Json, JsonError> {
        self.pos += 1; // '['
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            self.skip_ws();
            items.push(self.parse_value()?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Json::Arr(items));
                }
                _ => return Err(JsonError::Unexpected),
            }
        }
    }

    fn parse_string(&mut self) -> Result<String, JsonError> {
        self.pos += 1; // opening quote
        let mut out = String::new();
        loop {
            let c = self.peek().ok_or(JsonError::Eof)?;
            self.pos += 1;
            match c {
                b'"' => return Ok(out),
                b'\\' => {
                    let e = self.peek().ok_or(JsonError::Eof)?;
                    self.pos += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000C}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let cp = self.parse_hex4()?;
                            // Surrogate pair handling.
                            if (0xD800..=0xDBFF).contains(&cp) {
                                if self.peek() == Some(b'\\') {
                                    self.pos += 1;
                                    if self.peek() == Some(b'u') {
                                        self.pos += 1;
                                        let lo = self.parse_hex4()?;
                                        let c = 0x10000
                                            + (((cp - 0xD800) as u32) << 10)
                                            + (lo - 0xDC00) as u32;
                                        out.push(char::from_u32(c).ok_or(JsonError::BadEscape)?);
                                    } else {
                                        return Err(JsonError::BadEscape);
                                    }
                                } else {
                                    return Err(JsonError::BadEscape);
                                }
                            } else {
                                out.push(char::from_u32(cp as u32).ok_or(JsonError::BadEscape)?);
                            }
                        }
                        _ => return Err(JsonError::BadEscape),
                    }
                }
                _ => {
                    // Copy the full UTF-8 sequence starting at this byte.
                    let start = self.pos - 1;
                    let len = utf8_len(c);
                    if len == 0 || start + len > self.bytes.len() {
                        return Err(JsonError::Unexpected);
                    }
                    self.pos = start + len;
                    let s = core::str::from_utf8(&self.bytes[start..start + len])
                        .map_err(|_| JsonError::Unexpected)?;
                    out.push_str(s);
                }
            }
        }
    }

    fn parse_hex4(&mut self) -> Result<u16, JsonError> {
        if self.pos + 4 > self.bytes.len() {
            return Err(JsonError::BadEscape);
        }
        let mut v: u16 = 0;
        for _ in 0..4 {
            let d = self.bytes[self.pos];
            self.pos += 1;
            let nibble = match d {
                b'0'..=b'9' => d - b'0',
                b'a'..=b'f' => d - b'a' + 10,
                b'A'..=b'F' => d - b'A' + 10,
                _ => return Err(JsonError::BadEscape),
            };
            v = (v << 4) | nibble as u16;
        }
        Ok(v)
    }

    fn parse_number(&mut self) -> Result<Json, JsonError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() || c == b'.' || c == b'e' || c == b'E' || c == b'+' || c == b'-' {
                self.pos += 1;
            } else {
                break;
            }
        }
        let s =
            core::str::from_utf8(&self.bytes[start..self.pos]).map_err(|_| JsonError::BadNumber)?;
        parse_f64(s).map(Json::Num).ok_or(JsonError::BadNumber)
    }
}

fn utf8_len(first: u8) -> usize {
    match first {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => 0,
    }
}

/// Parse a JSON number into `f64` without `core::str::parse` (which pulls in
/// float formatting/parsing infra we keep lean). Handles sign, fraction, and
/// exponent.
pub fn parse_f64(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let mut i = 0;
    let n = b.len();
    if n == 0 {
        return None;
    }
    let mut neg = false;
    if b[i] == b'-' {
        neg = true;
        i += 1;
    } else if b[i] == b'+' {
        i += 1;
    }
    let mut mantissa: f64 = 0.0;
    let mut any = false;
    while i < n && b[i].is_ascii_digit() {
        mantissa = mantissa * 10.0 + (b[i] - b'0') as f64;
        i += 1;
        any = true;
    }
    if i < n && b[i] == b'.' {
        i += 1;
        let mut scale = 0.1;
        while i < n && b[i].is_ascii_digit() {
            mantissa += (b[i] - b'0') as f64 * scale;
            scale *= 0.1;
            i += 1;
            any = true;
        }
    }
    if !any {
        return None;
    }
    let mut exp: i32 = 0;
    if i < n && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        let mut eneg = false;
        if i < n && (b[i] == b'+' || b[i] == b'-') {
            eneg = b[i] == b'-';
            i += 1;
        }
        let mut e = 0i32;
        let mut eany = false;
        while i < n && b[i].is_ascii_digit() {
            e = e * 10 + (b[i] - b'0') as i32;
            i += 1;
            eany = true;
        }
        if !eany {
            return None;
        }
        exp = if eneg { -e } else { e };
    }
    if i != n {
        return None;
    }
    let mut value = mantissa;
    if exp != 0 {
        value *= pow10(exp);
    }
    Some(if neg { -value } else { value })
}

fn pow10(exp: i32) -> f64 {
    let mut r = 1.0f64;
    let mut e = exp.unsigned_abs();
    let mut base = 10.0f64;
    while e > 0 {
        if e & 1 == 1 {
            r *= base;
        }
        base *= base;
        e >>= 1;
    }
    if exp < 0 {
        1.0 / r
    } else {
        r
    }
}

// ============================================================================
// Writer
// ============================================================================

/// Builds a JSON string. Object/array structure is caller-driven; the float
/// writer round-trips f32 data.
pub struct JsonWriter {
    out: String,
    stack: Vec<Frame>,
}

#[derive(Clone, Copy)]
struct Frame {
    /// Whether this container already emitted a member (controls commas).
    has_member: bool,
    /// Set right after a key; the following value must not emit a comma.
    expecting_value: bool,
}

impl Default for JsonWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl JsonWriter {
    pub fn new() -> Self {
        Self {
            out: String::new(),
            stack: Vec::new(),
        }
    }

    pub fn into_string(self) -> String {
        self.out
    }

    fn pre_value(&mut self) {
        let comma = match self.stack.last_mut() {
            Some(f) => {
                if f.expecting_value {
                    f.expecting_value = false;
                    false
                } else {
                    let c = f.has_member;
                    f.has_member = true;
                    c
                }
            }
            None => false,
        };
        if comma {
            self.out.push(',');
        }
    }

    fn push_frame(&mut self) {
        self.stack.push(Frame {
            has_member: false,
            expecting_value: false,
        });
    }

    pub fn begin_obj(&mut self) {
        self.pre_value();
        self.out.push('{');
        self.push_frame();
    }

    pub fn end_obj(&mut self) {
        self.out.push('}');
        self.stack.pop();
    }

    pub fn begin_array(&mut self) {
        self.pre_value();
        self.out.push('[');
        self.push_frame();
    }

    pub fn end_array(&mut self) {
        self.out.push(']');
        self.stack.pop();
    }

    /// Begin an object-valued field: writes `"key":` then opens `{`.
    pub fn begin_obj_field(&mut self, key: &str) {
        self.key(key);
        self.begin_obj();
    }

    /// Write a field key `"key":`. The next value writer fills the slot without
    /// emitting a leading comma (tracked by `Frame::expecting_value`).
    pub fn key(&mut self, key: &str) {
        let comma = match self.stack.last_mut() {
            Some(f) => {
                let c = f.has_member;
                f.has_member = true;
                f.expecting_value = true;
                c
            }
            None => false,
        };
        if comma {
            self.out.push(',');
        }
        self.write_str_raw(key);
        self.out.push(':');
    }

    pub fn value_str(&mut self, s: &str) {
        self.pre_value();
        self.write_str_raw(s);
    }

    pub fn value_bool(&mut self, b: bool) {
        self.pre_value();
        self.out.push_str(if b { "true" } else { "false" });
    }

    pub fn value_null(&mut self) {
        self.pre_value();
        self.out.push_str("null");
    }

    pub fn value_i64(&mut self, n: i64) {
        self.pre_value();
        if n < 0 {
            self.out.push('-');
        }
        self.write_u64(n.unsigned_abs());
    }

    pub fn value_u64(&mut self, n: u64) {
        self.pre_value();
        self.write_u64(n);
    }

    /// Field convenience helpers.
    pub fn field_str(&mut self, key: &str, s: &str) {
        self.key(key);
        self.value_str(s);
    }
    pub fn field_f32(&mut self, key: &str, v: f32) {
        self.key(key);
        self.value_f32(v);
    }
    pub fn field_i64(&mut self, key: &str, v: i64) {
        self.key(key);
        self.value_i64(v);
    }
    pub fn field_bool(&mut self, key: &str, v: bool) {
        self.key(key);
        self.value_bool(v);
    }

    fn write_u64(&mut self, mut n: u64) {
        if n == 0 {
            self.out.push('0');
            return;
        }
        let mut buf = [0u8; 20];
        let mut i = buf.len();
        while n > 0 {
            i -= 1;
            buf[i] = b'0' + (n % 10) as u8;
            n /= 10;
        }
        self.out.push_str(core::str::from_utf8(&buf[i..]).unwrap());
    }

    fn write_str_raw(&mut self, s: &str) {
        self.out.push('"');
        for ch in s.chars() {
            match ch {
                '"' => self.out.push_str("\\\""),
                '\\' => self.out.push_str("\\\\"),
                '\n' => self.out.push_str("\\n"),
                '\r' => self.out.push_str("\\r"),
                '\t' => self.out.push_str("\\t"),
                '\u{0008}' => self.out.push_str("\\b"),
                '\u{000C}' => self.out.push_str("\\f"),
                c if (c as u32) < 0x20 => {
                    self.out.push_str("\\u00");
                    let byte = c as u32;
                    let hi = (byte >> 4) & 0xF;
                    let lo = byte & 0xF;
                    self.out.push(hex_digit(hi as u8));
                    self.out.push(hex_digit(lo as u8));
                }
                c => self.out.push(c),
            }
        }
        self.out.push('"');
    }

    /// Adaptive round-trip f32 writer: the fewest fractional digits (0..=9)
    /// whose decimal parses back to the same `f32`.
    pub fn value_f32(&mut self, v: f32) {
        self.pre_value();
        self.write_f32(v);
    }

    fn write_f32(&mut self, v: f32) {
        if !v.is_finite() {
            self.out.push('0');
            return;
        }
        if v == 0.0 {
            self.out.push('0');
            return;
        }
        let mut work = String::new();
        for digits in 0..=9u32 {
            work.clear();
            format_fixed(v, digits, &mut work);
            if let Some(parsed) = parse_f64(&work) {
                if parsed as f32 == v {
                    self.out.push_str(&work);
                    return;
                }
            }
        }
        // Fallback: 9 digits (already in `work`).
        self.out.push_str(&work);
    }
}

fn hex_digit(n: u8) -> char {
    if n < 10 {
        (b'0' + n) as char
    } else {
        (b'a' + (n - 10)) as char
    }
}

/// Format `v` with exactly `digits` fractional digits into `out`.
fn format_fixed(v: f32, digits: u32, out: &mut String) {
    let neg = v < 0.0;
    let mag = if neg { -v as f64 } else { v as f64 };
    let scale = pow10(digits as i32);
    let scaled = libm::round(mag * scale) as u128;
    let int_part = (scaled / scale as u128) as u128;
    let frac_part = (scaled % scale as u128) as u128;
    if neg {
        out.push('-');
    }
    push_u128(int_part, out);
    if digits > 0 {
        out.push('.');
        // Zero-pad the fractional part to `digits`.
        let mut buf = [0u8; 39];
        let mut i = buf.len();
        let mut f = frac_part;
        for _ in 0..digits {
            i -= 1;
            buf[i] = b'0' + (f % 10) as u8;
            f /= 10;
        }
        out.push_str(core::str::from_utf8(&buf[i..]).unwrap());
    }
}

fn push_u128(mut n: u128, out: &mut String) {
    if n == 0 {
        out.push('0');
        return;
    }
    let mut buf = [0u8; 39];
    let mut i = buf.len();
    while n > 0 {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
    }
    out.push_str(core::str::from_utf8(&buf[i..]).unwrap());
}

impl Json {
    /// Serialize back to a compact string (used by tests / debug).
    pub fn to_string_compact(&self) -> String {
        let mut w = JsonWriter::new();
        write_value(&mut w, self);
        w.into_string()
    }
}

fn write_value(w: &mut JsonWriter, v: &Json) {
    match v {
        Json::Null => w.value_null(),
        Json::Bool(b) => w.value_bool(*b),
        Json::Num(n) => {
            // Integers write cleanly; non-integers via f32 round-trip.
            if libm::trunc(*n) == *n && libm::fabs(*n) < 9.007e15 {
                w.value_i64(*n as i64);
            } else {
                w.value_f32(*n as f32);
            }
        }
        Json::Str(s) => w.value_str(s),
        Json::Arr(items) => {
            w.begin_array();
            for it in items {
                write_value(w, it);
            }
            w.end_array();
        }
        Json::Obj(fields) => {
            w.begin_obj();
            for (k, val) in fields {
                w.key(k);
                write_value(w, val);
            }
            w.end_obj();
        }
    }
}

/// Convenience for tests/tools needing an owned string of any displayable.
pub fn to_json_string(v: &Json) -> String {
    v.to_string_compact()
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    #[test]
    fn parse_scalars() {
        assert_eq!(Json::parse("true"), Ok(Json::Bool(true)));
        assert_eq!(Json::parse("null"), Ok(Json::Null));
        assert_eq!(Json::parse("-12.5"), Ok(Json::Num(-12.5)));
        assert_eq!(Json::parse("\"hi\\n\""), Ok(Json::Str("hi\n".into())));
    }

    #[test]
    fn parse_object_and_get() {
        let j = Json::parse(r#"{ "a": 1, "b": [true, "x"], "c": { "d": 2.5 } }"#).unwrap();
        assert_eq!(j.get("a").and_then(Json::as_i64), Some(1));
        assert_eq!(
            j.get("b").and_then(Json::as_array).map(|a| a.len()),
            Some(2)
        );
        assert_eq!(
            j.get("c").and_then(|c| c.get("d")).and_then(Json::as_f64),
            Some(2.5)
        );
    }

    #[test]
    fn parse_exponent_and_unicode() {
        assert_eq!(Json::parse("1e3"), Ok(Json::Num(1000.0)));
        assert_eq!(Json::parse("2.5e-1"), Ok(Json::Num(0.25)));
        assert_eq!(Json::parse("\"\\u0041\""), Ok(Json::Str("A".into())));
    }

    #[test]
    fn writer_roundtrips_f32() {
        for v in [
            0.0f32,
            1.0,
            -2.5,
            0.021,
            1024.0,
            0.5,
            89.0 / 255.0,
            3.1415927,
        ] {
            let mut w = JsonWriter::new();
            w.value_f32(v);
            let s = w.into_string();
            let back = parse_f64(&s).unwrap() as f32;
            assert_eq!(back, v, "f32 {v} wrote {s} parsed {back}");
        }
    }

    #[test]
    fn writer_object_structure() {
        let mut w = JsonWriter::new();
        w.begin_obj();
        w.field_str("schema", "successor.prefab.v1");
        w.key("pos");
        w.begin_array();
        w.value_f32(1.0);
        w.value_f32(2.5);
        w.end_array();
        w.field_bool("flag", true);
        w.end_obj();
        let s = w.into_string();
        let j = Json::parse(&s).unwrap();
        assert_eq!(
            j.get("schema").and_then(Json::as_str),
            Some("successor.prefab.v1")
        );
        assert_eq!(j.get("flag").and_then(Json::as_bool), Some(true));
        assert_eq!(
            j.get("pos").and_then(Json::as_array).map(|a| a.len()),
            Some(2)
        );
    }
}

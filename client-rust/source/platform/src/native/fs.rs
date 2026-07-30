//! Native filesystem read for local asset directories.

use std::path::Path;

/// Read an entire file into memory. Errors carry the path for diagnostics.
pub fn fs_read(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(Path::new(path)).map_err(|e| format!("read {path}: {e}"))
}

/// True when a file exists and is readable.
pub fn fs_exists(path: &str) -> bool {
    Path::new(path).is_file()
}

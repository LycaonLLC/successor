//! Native filesystem access for local asset directories.

use std::io::Write;
use std::path::Path;

/// Read an entire file into memory. Errors carry the path for diagnostics.
pub fn fs_read(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(Path::new(path)).map_err(|e| format!("read {path}: {e}"))
}

/// True when a file exists and is readable.
pub fn fs_exists(path: &str) -> bool {
    Path::new(path).is_file()
}

/// Atomically replace a file by syncing a sibling temporary file, then
/// renaming it over the destination. The sibling keeps the rename on one
/// filesystem; a process suffix avoids two developer clients sharing a temp.
pub fn fs_write_atomic(path: &str, bytes: &[u8]) -> Result<(), String> {
    let destination = Path::new(path);
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let temporary = destination.with_extension(format!(
        "{}.tmp-{}",
        destination
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("file"),
        std::process::id()
    ));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("open {}: {error}", temporary.display()))?;
        file.write_all(bytes)
            .map_err(|error| format!("write {}: {error}", temporary.display()))?;
        file.sync_all()
            .map_err(|error| format!("sync {}: {error}", temporary.display()))?;
        std::fs::rename(&temporary, destination).map_err(|error| {
            format!(
                "replace {} from {}: {error}",
                destination.display(),
                temporary.display()
            )
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

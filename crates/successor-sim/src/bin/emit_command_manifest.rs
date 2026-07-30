use std::{
    env, fs,
    io::{self, Write},
    path::Path,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let json = successor_sim::command_manifest::command_manifest_json_pretty()?;
    match env::args().nth(1) {
        Some(path) => {
            let path = Path::new(&path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(path, format!("{json}\n"))?;
        }
        None => {
            let mut stdout = io::stdout().lock();
            stdout.write_all(json.as_bytes())?;
            stdout.write_all(b"\n")?;
        }
    }
    Ok(())
}

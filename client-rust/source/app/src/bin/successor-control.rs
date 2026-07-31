//! Pipeable developer control client for the native Successor client.

use std::fs::File;
use std::io::{self, BufRead, BufReader, IsTerminal, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

const DEFAULT_PORT: u16 = successor_platform::DEFAULT_CONTROL_PORT;

fn main() {
    if let Err(error) = run() {
        eprintln!("successor-control: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut port = std::env::var("SUCCESSOR_CONTROL_PORT")
        .ok()
        .map(|value| parse_port(&value))
        .transpose()?
        .unwrap_or(DEFAULT_PORT);
    let mut file: Option<PathBuf> = None;
    let mut command_start = 0;

    while command_start < args.len() {
        match args[command_start].as_str() {
            "--port" => {
                let value = args
                    .get(command_start + 1)
                    .ok_or_else(|| "--port requires a number".to_string())?;
                port = parse_port(value)?;
                command_start += 2;
            }
            "--file" => {
                let value = args
                    .get(command_start + 1)
                    .ok_or_else(|| "--file requires a path".to_string())?;
                file = Some(PathBuf::from(value));
                command_start += 2;
            }
            "--help" | "-h" => {
                print_usage();
                return Ok(());
            }
            _ => break,
        }
    }

    if file.is_some() && command_start < args.len() {
        return Err("commands cannot be combined with --file".into());
    }
    if file.is_none() && command_start == args.len() && io::stdin().is_terminal() {
        print_usage();
        return Err("provide a command, --file, or piped stdin".into());
    }

    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let mut writer = TcpStream::connect_timeout(&address.into(), Duration::from_secs(3))
        .map_err(|error| format!("cannot connect to 127.0.0.1:{port}: {error}"))?;
    writer
        .set_nodelay(true)
        .map_err(|error| format!("cannot configure control socket: {error}"))?;
    writer
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| format!("cannot configure response timeout: {error}"))?;
    let reader_stream = writer
        .try_clone()
        .map_err(|error| format!("cannot clone control socket: {error}"))?;
    let mut reader = BufReader::new(reader_stream);
    let mut sequence = 1u64;
    let mut failed = false;

    if let Some(path) = file {
        let source = File::open(&path)
            .map_err(|error| format!("cannot open command file {}: {error}", path.display()))?;
        drive_lines(
            BufReader::new(source),
            &mut writer,
            &mut reader,
            &mut sequence,
            &mut failed,
        )?;
    } else if command_start < args.len() {
        let command = args[command_start..].join(" ");
        drive_command(
            &command,
            &mut writer,
            &mut reader,
            &mut sequence,
            &mut failed,
        )?;
    } else {
        let stdin = io::stdin();
        drive_lines(
            stdin.lock(),
            &mut writer,
            &mut reader,
            &mut sequence,
            &mut failed,
        )?;
    }

    if failed {
        Err("one or more commands failed".into())
    } else {
        Ok(())
    }
}

fn drive_lines<R: BufRead>(
    source: R,
    writer: &mut TcpStream,
    reader: &mut BufReader<TcpStream>,
    sequence: &mut u64,
    failed: &mut bool,
) -> Result<(), String> {
    for (line_number, line) in source.lines().enumerate() {
        let line =
            line.map_err(|error| format!("cannot read line {}: {error}", line_number + 1))?;
        let command = line.trim();
        if command.is_empty() || command.starts_with('#') {
            continue;
        }
        drive_command(command, writer, reader, sequence, failed)
            .map_err(|error| format!("line {}: {error}", line_number + 1))?;
    }
    Ok(())
}

fn drive_command(
    command: &str,
    writer: &mut TcpStream,
    reader: &mut BufReader<TcpStream>,
    sequence: &mut u64,
    failed: &mut bool,
) -> Result<(), String> {
    if let Some(value) = command.strip_prefix("wait ") {
        let milliseconds = value
            .trim()
            .parse::<u64>()
            .map_err(|_| "wait requires milliseconds".to_string())?;
        std::thread::sleep(Duration::from_millis(milliseconds));
        println!("{{\"ok\":true,\"wait_ms\":{milliseconds}}}");
        return Ok(());
    }
    if command == "wait" {
        return Err("wait requires milliseconds".into());
    }

    writeln!(writer, "{}\t{}", *sequence, command)
        .map_err(|error| format!("cannot send command: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("cannot flush command: {error}"))?;

    let mut response = String::new();
    let bytes = reader
        .read_line(&mut response)
        .map_err(|error| format!("cannot read response: {error}"))?;
    if bytes == 0 {
        return Err("control server closed before responding".into());
    }
    print!("{response}");
    io::stdout()
        .flush()
        .map_err(|error| format!("cannot flush output: {error}"))?;
    if response.contains("\"ok\":false") {
        *failed = true;
    }
    *sequence = sequence.saturating_add(1);
    Ok(())
}

fn parse_port(value: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .map_err(|_| format!("invalid port: {value}"))
}

fn print_usage() {
    eprintln!(
        "usage:\n  successor-control [--port N] <command ...>\n  successor-control [--port N] --file commands.txt\n  printf 'key down w\\nwait 500\\nkey up w\\nscreenshot /tmp/game.bmp\\n' | successor-control [--port N]\n\nserver commands:\n  key <down|up|tap> <w|a|s|d|up|down|left|right|space|enter|escape|backspace|shift>\n  mouse move <abs|rel> <x> <y>\n  mouse <down|up> <left|right|middle>\n  text <text>\n  scroll <x> <y>\n  screenshot <path.bmp>\n  record start <path.input> | record stop\n  status | quit\n\nclient-only command:\n  wait <milliseconds>"
    );
}

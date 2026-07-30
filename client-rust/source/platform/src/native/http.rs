//! Native HTTP JSON POST implementation over TcpStream and native-tls.

use std::io::{Read, Write};
use std::net::TcpStream;
use url::Url;
use native_tls::TlsConnector;

pub fn http_post_json(url_str: &str, body: &[u8]) -> Result<Vec<u8>, String> {
    let parsed_url = Url::parse(url_str).map_err(|e| e.to_string())?;
    let host = parsed_url.host_str().ok_or_else(|| "Missing host in URL".to_string())?;
    let port = parsed_url.port_or_known_default().ok_or_else(|| "Could not determine port".to_string())?;
    let path = parsed_url.path();
    let query = parsed_url.query();
    
    let full_path = if let Some(q) = query {
        format!("{}?{}", path, q)
    } else {
        path.to_string()
    };

    let stream = TcpStream::connect(format!("{}:{}", host, port)).map_err(|e| e.to_string())?;

    let is_https = parsed_url.scheme() == "https";

    let mut response = Vec::new();
    let mut request = Vec::new();

    request.extend_from_slice(format!(
        "POST {} HTTP/1.1\r\n\
         Host: {}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        full_path, host, body.len()
    ).as_bytes());
    request.extend_from_slice(body);

    if is_https {
        let connector = TlsConnector::new().map_err(|e| e.to_string())?;
        let mut tls_stream = connector.connect(host, stream).map_err(|e| e.to_string())?;
        tls_stream.write_all(&request).map_err(|e| e.to_string())?;
        tls_stream.flush().map_err(|e| e.to_string())?;
        tls_stream.read_to_end(&mut response).map_err(|e| e.to_string())?;
    } else {
        let mut raw_stream = stream;
        raw_stream.write_all(&request).map_err(|e| e.to_string())?;
        raw_stream.flush().map_err(|e| e.to_string())?;
        raw_stream.read_to_end(&mut response).map_err(|e| e.to_string())?;
    }

    // Split response into headers and body
    let mut header_end = None;
    for i in 0..response.len().saturating_sub(3) {
        if &response[i..i+4] == b"\r\n\r\n" {
            header_end = Some(i);
            break;
        }
    }

    let header_end = header_end.ok_or_else(|| "Invalid HTTP response (missing header separator)".to_string())?;
    let headers_part = &response[..header_end];
    let body_part = &response[header_end+4..];

    // Parse status code from headers
    let headers_str = std::str::from_utf8(headers_part).map_err(|_| "Invalid UTF-8 in HTTP headers".to_string())?;
    let mut lines = headers_str.lines();
    let status_line = lines.next().ok_or_else(|| "Empty HTTP response".to_string())?;
    let parts: Vec<&str> = status_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Err("Invalid HTTP status line".to_string());
    }

    let status_code = parts[1].parse::<u32>().map_err(|_| "Invalid HTTP status code".to_string())?;
    if status_code != 200 {
        return Err(format!("HTTP request failed with status code: {}", status_code));
    }

    Ok(body_part.to_vec())
}

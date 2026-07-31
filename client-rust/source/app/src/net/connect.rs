//! Connection URL and JoinOptions parsing for the playable slice.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinOptions {
    pub endpoint: String,
    pub player_id: String,
    pub actor_id: String,
    pub ticket: Option<String>,
    pub release: Option<String>,
}

/// Helper to percent-decode a string, handling standard hex escapes and '+' to space conversion.
fn percent_decode(s: &str) -> String {
    let mut bytes = Vec::with_capacity(s.len());
    let s_bytes = s.as_bytes();
    let mut i = 0;
    while i < s_bytes.len() {
        if s_bytes[i] == b'%' && i + 2 < s_bytes.len() {
            let h1 = s_bytes[i + 1];
            let h2 = s_bytes[i + 2];
            if let (Some(d1), Some(d2)) = (char::from(h1).to_digit(16), char::from(h2).to_digit(16))
            {
                bytes.push(((d1 << 4) | d2) as u8);
                i += 3;
                continue;
            }
        }
        if s_bytes[i] == b'+' {
            bytes.push(b' ');
        } else {
            bytes.push(s_bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Parses a connection/play-launch URL and extracts the join parameters.
/// Accepts ws://, wss://, http://, and https:// variants.
pub fn parse_connect_url(url: &str) -> Option<JoinOptions> {
    if !(url.starts_with("ws://")
        || url.starts_with("wss://")
        || url.starts_with("http://")
        || url.starts_with("https://"))
    {
        return None;
    }

    // Split query and fragment out
    let without_fragment = match url.find('#') {
        Some(idx) => &url[..idx],
        None => url,
    };

    let (endpoint, query_str) = match without_fragment.find('?') {
        Some(idx) => (&without_fragment[..idx], &without_fragment[idx + 1..]),
        None => (without_fragment, ""),
    };

    let mut player_id = None;
    let mut actor_id = None;
    let mut ticket = None;
    let mut release = None;

    if !query_str.is_empty() {
        for part in query_str.split('&') {
            if part.is_empty() {
                continue;
            }
            let mut kv = part.splitn(2, '=');
            let key = kv.next().unwrap_or("");
            let val = kv.next().unwrap_or("");

            let decoded_key = percent_decode(key);
            let decoded_val = percent_decode(val);

            match decoded_key.as_str() {
                "player" => player_id = Some(decoded_val),
                "actor" => actor_id = Some(decoded_val),
                "ticket" => ticket = Some(decoded_val),
                "release" => release = Some(decoded_val),
                _ => {}
            }
        }
    }

    Some(JoinOptions {
        endpoint: endpoint.to_string(),
        player_id: player_id.unwrap_or_else(|| "dev-1".to_string()),
        actor_id: actor_id.unwrap_or_else(|| "dev-1".to_string()),
        ticket,
        release,
    })
}

/// Maps wss:// to https:// and ws:// to http://.
pub fn http_endpoint(endpoint: &str) -> String {
    endpoint
        .replacen("wss://", "https://", 1)
        .replacen("ws://", "http://", 1)
}

/// Builds the Colyseus matchmaker POST path for a room.
pub fn matchmake_path(room: &str) -> String {
    format!("/matchmake/joinOrCreate/{}", room)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_full_url() {
        let url = "ws://127.0.0.1:28093/?player=p1&actor=a1&ticket=t1&release=r1";
        let parsed = parse_connect_url(url).unwrap();
        assert_eq!(parsed.endpoint, "ws://127.0.0.1:28093/");
        assert_eq!(parsed.player_id, "p1");
        assert_eq!(parsed.actor_id, "a1");
        assert_eq!(parsed.ticket, Some("t1".to_string()));
        assert_eq!(parsed.release, Some("r1".to_string()));
    }

    #[test]
    fn test_parse_empty_params_but_present() {
        let url = "ws://127.0.0.1:28093/?player=&actor=&ticket=&release=";
        let parsed = parse_connect_url(url).unwrap();
        assert_eq!(parsed.endpoint, "ws://127.0.0.1:28093/");
        assert_eq!(parsed.player_id, "");
        assert_eq!(parsed.actor_id, "");
        assert_eq!(parsed.ticket, Some("".to_string()));
        assert_eq!(parsed.release, Some("".to_string()));
    }

    #[test]
    fn test_defaults_when_absent() {
        let url = "ws://127.0.0.1:28093/";
        let parsed = parse_connect_url(url).unwrap();
        assert_eq!(parsed.endpoint, "ws://127.0.0.1:28093/");
        assert_eq!(parsed.player_id, "dev-1");
        assert_eq!(parsed.actor_id, "dev-1");
        assert_eq!(parsed.ticket, None);
        assert_eq!(parsed.release, None);
    }

    #[test]
    fn test_http_endpoint_mapping() {
        assert_eq!(
            http_endpoint("ws://127.0.0.1:28093/"),
            "http://127.0.0.1:28093/"
        );
        assert_eq!(
            http_endpoint("wss://127.0.0.1:28093/"),
            "https://127.0.0.1:28093/"
        );
        assert_eq!(http_endpoint("http://example.com/"), "http://example.com/");
        assert_eq!(
            http_endpoint("https://example.com/"),
            "https://example.com/"
        );
    }

    #[test]
    fn test_percent_decoding() {
        let url = "ws://127.0.0.1:28093/?player=dev%2D1&actor=dev%202&ticket=a%2Bb%25c";
        let parsed = parse_connect_url(url).unwrap();
        assert_eq!(parsed.player_id, "dev-1");
        assert_eq!(parsed.actor_id, "dev 2");
        assert_eq!(parsed.ticket, Some("a+b%c".to_string()));

        let url2 = "ws://127.0.0.1:28093/?player=dev%2d1";
        let parsed2 = parse_connect_url(url2).unwrap();
        assert_eq!(parsed2.player_id, "dev-1");

        let url3 = "ws://127.0.0.1:28093/?player=dev+space";
        let parsed3 = parse_connect_url(url3).unwrap();
        assert_eq!(parsed3.player_id, "dev space");
    }

    #[test]
    fn test_wss_url_parses() {
        let url = "wss://secure.example.com:28093/path?player=bob";
        let parsed = parse_connect_url(url).unwrap();
        assert_eq!(parsed.endpoint, "wss://secure.example.com:28093/path");
        assert_eq!(parsed.player_id, "bob");
        assert_eq!(parsed.actor_id, "dev-1");
    }

    #[test]
    fn test_matchmake_path() {
        assert_eq!(matchmake_path("game"), "/matchmake/joinOrCreate/game");
        assert_eq!(matchmake_path("lobby"), "/matchmake/joinOrCreate/lobby");
    }
}

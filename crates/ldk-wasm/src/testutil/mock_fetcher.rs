use crate::io::Fetcher;
use std::cell::RefCell;
use std::collections::HashMap;

/// A canned response for a mock route.
#[derive(Clone, Debug)]
pub enum MockResponse {
    /// Return `Ok(bytes)` from get_json, get_bytes, or post_bytes.
    Ok(Vec<u8>),
    /// Return `Ok(text)` from get_text (also used for get_json when text is convenient).
    OkText(String),
    /// Return `Err(message)`.
    Err(String),
}

/// A recorded request captured by the mock fetcher.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct RecordedRequest {
    pub method: String,
    pub url: String,
    pub body: Option<Vec<u8>>,
}

/// A URL-pattern-based HTTP mock for the `Fetcher` trait.
///
/// Register routes with `on_get_json`, `on_post_bytes`, etc. Routes are matched
/// first by exact URL, then by substring containment.
pub struct MockFetcher {
    get_json_routes: RefCell<HashMap<String, MockResponse>>,
    get_text_routes: RefCell<HashMap<String, MockResponse>>,
    get_bytes_routes: RefCell<HashMap<String, MockResponse>>,
    post_bytes_routes: RefCell<HashMap<String, MockResponse>>,
    recorded: RefCell<Vec<RecordedRequest>>,
}

impl MockFetcher {
    pub fn new() -> Self {
        Self {
            get_json_routes: RefCell::new(HashMap::new()),
            get_text_routes: RefCell::new(HashMap::new()),
            get_bytes_routes: RefCell::new(HashMap::new()),
            post_bytes_routes: RefCell::new(HashMap::new()),
            recorded: RefCell::new(Vec::new()),
        }
    }

    pub fn on_get_json(&self, url_pattern: &str, response: MockResponse) -> &Self {
        self.get_json_routes
            .borrow_mut()
            .insert(url_pattern.to_string(), response);
        self
    }

    pub fn on_get_text(&self, url_pattern: &str, response: MockResponse) -> &Self {
        self.get_text_routes
            .borrow_mut()
            .insert(url_pattern.to_string(), response);
        self
    }

    #[allow(dead_code)]
    pub fn on_get_bytes(&self, url_pattern: &str, response: MockResponse) -> &Self {
        self.get_bytes_routes
            .borrow_mut()
            .insert(url_pattern.to_string(), response);
        self
    }

    pub fn on_post_bytes(&self, url_pattern: &str, response: MockResponse) -> &Self {
        self.post_bytes_routes
            .borrow_mut()
            .insert(url_pattern.to_string(), response);
        self
    }

    /// Return all recorded requests.
    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.recorded.borrow().clone()
    }

    /// Return recorded requests whose URL contains the given substring.
    pub fn requests_matching(&self, url_contains: &str) -> Vec<RecordedRequest> {
        self.recorded
            .borrow()
            .iter()
            .filter(|r| r.url.contains(url_contains))
            .cloned()
            .collect()
    }
}

fn find_route(routes: &HashMap<String, MockResponse>, url: &str) -> Option<MockResponse> {
    // Try exact match first.
    if let Some(resp) = routes.get(url) {
        return Some(resp.clone());
    }
    // Fall back to substring match.
    for (pattern, resp) in routes.iter() {
        if url.contains(pattern.as_str()) {
            return Some(resp.clone());
        }
    }
    None
}

impl Fetcher for MockFetcher {
    async fn get_json(&self, url: &str) -> Result<Vec<u8>, String> {
        self.recorded.borrow_mut().push(RecordedRequest {
            method: "GET_JSON".into(),
            url: url.to_string(),
            body: None,
        });
        match find_route(&self.get_json_routes.borrow(), url) {
            Some(MockResponse::Ok(bytes)) => Ok(bytes),
            Some(MockResponse::OkText(text)) => Ok(text.into_bytes()),
            Some(MockResponse::Err(e)) => Err(e),
            None => Err(format!("MockFetcher: no route for GET_JSON {}", url)),
        }
    }

    async fn get_text(&self, url: &str) -> Result<String, String> {
        self.recorded.borrow_mut().push(RecordedRequest {
            method: "GET_TEXT".into(),
            url: url.to_string(),
            body: None,
        });
        match find_route(&self.get_text_routes.borrow(), url) {
            Some(MockResponse::OkText(text)) => Ok(text),
            Some(MockResponse::Ok(bytes)) => {
                String::from_utf8(bytes).map_err(|e| format!("MockFetcher: invalid UTF-8: {}", e))
            }
            Some(MockResponse::Err(e)) => Err(e),
            None => Err(format!("MockFetcher: no route for GET_TEXT {}", url)),
        }
    }

    async fn get_bytes(&self, url: &str) -> Result<Vec<u8>, String> {
        self.recorded.borrow_mut().push(RecordedRequest {
            method: "GET_BYTES".into(),
            url: url.to_string(),
            body: None,
        });
        match find_route(&self.get_bytes_routes.borrow(), url) {
            Some(MockResponse::Ok(bytes)) => Ok(bytes),
            Some(MockResponse::OkText(text)) => Ok(text.into_bytes()),
            Some(MockResponse::Err(e)) => Err(e),
            None => Err(format!("MockFetcher: no route for GET_BYTES {}", url)),
        }
    }

    async fn post_bytes(&self, url: &str, body: &[u8]) -> Result<Vec<u8>, String> {
        self.recorded.borrow_mut().push(RecordedRequest {
            method: "POST_BYTES".into(),
            url: url.to_string(),
            body: Some(body.to_vec()),
        });
        match find_route(&self.post_bytes_routes.borrow(), url) {
            Some(MockResponse::Ok(bytes)) => Ok(bytes),
            Some(MockResponse::OkText(text)) => Ok(text.into_bytes()),
            Some(MockResponse::Err(e)) => Err(e),
            None => Err(format!("MockFetcher: no route for POST_BYTES {}", url)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    #[wasm_bindgen_test]
    async fn test_exact_route_match() {
        let f = MockFetcher::new();
        f.on_get_json(
            "https://example.com/api",
            MockResponse::OkText(r#"{"ok":true}"#.into()),
        );

        let resp = f.get_json("https://example.com/api").await.unwrap();
        assert_eq!(resp, br#"{"ok":true}"#);
    }

    #[wasm_bindgen_test]
    async fn test_substring_route_match() {
        let f = MockFetcher::new();
        f.on_get_text("/status", MockResponse::OkText("alive".into()));

        let resp = f.get_text("https://example.com/status?v=1").await.unwrap();
        assert_eq!(resp, "alive");
    }

    #[wasm_bindgen_test]
    async fn test_no_route_returns_error() {
        let f = MockFetcher::new();
        let result = f.get_bytes("https://nowhere.com").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no route"));
    }

    #[wasm_bindgen_test]
    async fn test_error_response() {
        let f = MockFetcher::new();
        f.on_post_bytes("/fail", MockResponse::Err("server error".into()));

        let result = f.post_bytes("https://x.com/fail", b"body").await;
        assert_eq!(result.unwrap_err(), "server error");
    }

    #[wasm_bindgen_test]
    async fn test_requests_recorded() {
        let f = MockFetcher::new();
        f.on_get_json("/a", MockResponse::Ok(vec![]));
        f.on_post_bytes("/b", MockResponse::Ok(vec![]));

        let _ = f.get_json("https://x.com/a").await;
        let _ = f.post_bytes("https://x.com/b", b"body").await;

        assert_eq!(f.requests().len(), 2);
        assert_eq!(f.requests_matching("/b").len(), 1);
        assert_eq!(f.requests_matching("/b")[0].method, "POST_BYTES");
    }
}

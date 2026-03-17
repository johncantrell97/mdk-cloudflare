/// Yield to the JS event loop. CF Workers kills workers that run too much
/// synchronous CPU without yielding ("hung worker" detection). Only real
/// I/O (like fetch) resets the detector — setTimeout and resolved promises
/// do NOT suffice in the CF runtime.
pub async fn yield_now(fetcher: &impl Fetcher) {
    // A minimal GET to a fast endpoint forces a real I/O yield.
    // The response is discarded; this exists solely to reset the hung detector.
    let _ = fetcher.get_text("https://1.1.1.1/cdn-cgi/trace").await;
}

/// Time provider trait. Abstracts js_sys::Date::now() for testability.
pub trait Clock {
    fn now_millis(&self) -> f64;
    fn now_secs(&self) -> u64 {
        (self.now_millis() / 1000.0) as u64
    }
    fn now_secs_u32(&self) -> u32 {
        self.now_secs() as u32
    }
}

/// Production `Clock` implementation using js_sys::Date::now().
pub struct JsClock;
impl Clock for JsClock {
    fn now_millis(&self) -> f64 {
        js_sys::Date::now()
    }
}

/// Abstraction over HTTP fetch operations.
///
/// The production implementation (`JsFetcherImpl`) delegates to the JS `JsFetcher` via
/// `wasm_bindgen`. Tests can provide a mock implementation without touching JS/WASM.
#[allow(async_fn_in_trait)]
pub trait Fetcher {
    async fn get_json(&self, url: &str) -> Result<Vec<u8>, String>;
    async fn get_text(&self, url: &str) -> Result<String, String>;
    async fn get_bytes(&self, url: &str) -> Result<Vec<u8>, String>;
    async fn post_bytes(&self, url: &str, body: &[u8]) -> Result<Vec<u8>, String>;
}

/// Production `Fetcher` implementation wrapping the JS-provided `JsFetcher`.
pub struct JsFetcherImpl<'a> {
    inner: &'a crate::JsFetcher,
}

impl<'a> JsFetcherImpl<'a> {
    pub fn new(inner: &'a crate::JsFetcher) -> Self {
        Self { inner }
    }
}

impl Fetcher for JsFetcherImpl<'_> {
    async fn get_json(&self, url: &str) -> Result<Vec<u8>, String> {
        // Use get_text to avoid JS parse -> stringify -> Rust parse round-trip.
        // JS get_json does resp.json() (parses into JS object), then we'd have to
        // JSON.stringify it back. get_text returns the raw response body directly.
        let text = self
            .inner
            .get_text(url)
            .await
            .map_err(|e| format!("{:?}", e))?;
        let s = text
            .as_string()
            .ok_or_else(|| "get_json: result is not a string".to_string())?;
        Ok(s.into_bytes())
    }

    async fn get_text(&self, url: &str) -> Result<String, String> {
        let result = self
            .inner
            .get_text(url)
            .await
            .map_err(|e| format!("{:?}", e))?;
        result
            .as_string()
            .ok_or_else(|| "get_text: result is not a string".to_string())
    }

    async fn get_bytes(&self, url: &str) -> Result<Vec<u8>, String> {
        let result = self
            .inner
            .get_bytes(url)
            .await
            .map_err(|e| format!("{:?}", e))?;
        Ok(js_sys::Uint8Array::new(&result).to_vec())
    }

    async fn post_bytes(&self, url: &str, body: &[u8]) -> Result<Vec<u8>, String> {
        let result = self
            .inner
            .post_bytes(url, body)
            .await
            .map_err(|e| format!("{:?}", e))?;
        let s = result
            .as_string()
            .ok_or_else(|| "post_bytes: result is not a string".to_string())?;
        Ok(s.into_bytes())
    }
}

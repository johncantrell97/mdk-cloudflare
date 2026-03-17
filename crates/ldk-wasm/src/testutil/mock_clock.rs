use crate::io::Clock;
use std::cell::Cell;

/// A controllable clock for tests. Uses `Cell<f64>` since WASM is single-threaded.
pub struct MockClock {
    millis: Cell<f64>,
    /// If > 0, each call to `now_millis()` advances the clock by this amount.
    auto_advance: Cell<f64>,
}

impl MockClock {
    /// Create a new `MockClock` starting at the given millisecond timestamp.
    pub fn new(initial_millis: f64) -> Self {
        Self {
            millis: Cell::new(initial_millis),
            auto_advance: Cell::new(0.0),
        }
    }

    /// Create a `MockClock` set to 2024-01-01T00:00:00Z (1704067200000 ms).
    pub fn default_time() -> Self {
        Self::new(1_704_067_200_000.0)
    }

    /// Advance the clock by the given number of milliseconds.
    pub fn advance_ms(&self, ms: f64) {
        self.millis.set(self.millis.get() + ms);
    }

    /// Advance the clock by the given number of seconds.
    pub fn advance_secs(&self, secs: u64) {
        self.advance_ms(secs as f64 * 1000.0);
    }

    /// Set auto-advance: each call to `now_millis()` will advance the clock by this amount.
    pub fn set_auto_advance(&self, ms: f64) {
        self.auto_advance.set(ms);
    }
}

impl Clock for MockClock {
    fn now_millis(&self) -> f64 {
        let current = self.millis.get();
        let advance = self.auto_advance.get();
        if advance > 0.0 {
            self.millis.set(current + advance);
        }
        current
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    #[wasm_bindgen_test]
    fn test_default_time() {
        let clock = MockClock::default_time();
        assert_eq!(clock.now_millis(), 1_704_067_200_000.0);
    }

    #[wasm_bindgen_test]
    fn test_now_secs() {
        let clock = MockClock::default_time();
        assert_eq!(clock.now_secs(), 1_704_067_200);
    }

    #[wasm_bindgen_test]
    fn test_advance_ms() {
        let clock = MockClock::new(1000.0);
        clock.advance_ms(500.0);
        assert_eq!(clock.now_millis(), 1500.0);
    }

    #[wasm_bindgen_test]
    fn test_advance_secs() {
        let clock = MockClock::new(0.0);
        clock.advance_secs(10);
        assert_eq!(clock.now_millis(), 10_000.0);
    }

    #[wasm_bindgen_test]
    fn test_now_secs_u32() {
        let clock = MockClock::default_time();
        // 1704067200 fits in u32
        assert_eq!(clock.now_secs_u32(), 1_704_067_200u32);
    }

    #[wasm_bindgen_test]
    fn test_auto_advance() {
        let clock = MockClock::new(1000.0);
        clock.set_auto_advance(100.0);
        assert_eq!(clock.now_millis(), 1000.0); // returns current, then advances
        assert_eq!(clock.now_millis(), 1100.0);
        assert_eq!(clock.now_millis(), 1200.0);
    }
}

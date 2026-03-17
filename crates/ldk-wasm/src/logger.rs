use lightning::util::logger::{Logger, Record};

use crate::JsLogFn;

/// Logger that delegates to a JavaScript callback.
/// Falls back to silently dropping if no callback provided.
pub struct JsLogger {
    callback: Option<JsLogFn>,
}

impl JsLogger {
    pub fn new(callback: Option<JsLogFn>) -> Self {
        Self { callback }
    }
}

// Sound: WASM is single-threaded. JsLogFn is a JS object that won't cross threads.
unsafe impl Send for JsLogger {}
unsafe impl Sync for JsLogger {}

/// Log an info-level message to the JS logger.
pub fn log_info(logger: &JsLogger, msg: &str) {
    if let Some(ref cb) = logger.callback {
        cb.log("INFO", msg);
    }
}

impl Logger for JsLogger {
    fn log(&self, record: Record) {
        // Skip gossip and trace to stay within CF Workers' 256KB log limit
        match record.level {
            lightning::util::logger::Level::Gossip => return,
            lightning::util::logger::Level::Trace => return,
            _ => {}
        }

        let level = match record.level {
            lightning::util::logger::Level::Gossip => "GOSSIP",
            lightning::util::logger::Level::Trace => "TRACE",
            lightning::util::logger::Level::Debug => "DEBUG",
            lightning::util::logger::Level::Info => "INFO",
            lightning::util::logger::Level::Warn => "WARN",
            lightning::util::logger::Level::Error => "ERROR",
        };

        if let Some(ref cb) = self.callback {
            let msg = format!("[{}:{}] {}", record.module_path, record.line, record.args);
            cb.log(level, &msg);
        }
    }
}

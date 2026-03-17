use core::fmt;

#[derive(Debug)]
pub enum TxSyncError {
    Failed,
}

impl std::error::Error for TxSyncError {}

impl fmt::Display for TxSyncError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match *self {
            Self::Failed => write!(f, "Failed to conduct transaction sync."),
        }
    }
}

#[derive(Debug)]
pub(crate) enum InternalError {
    Failed,
    Inconsistency,
}

impl fmt::Display for InternalError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match *self {
            Self::Failed => write!(f, "Failed to conduct transaction sync."),
            Self::Inconsistency => {
                write!(f, "Encountered an inconsistency during transaction sync.")
            }
        }
    }
}

impl std::error::Error for InternalError {}

impl From<InternalError> for TxSyncError {
    fn from(_e: InternalError) -> Self {
        Self::Failed
    }
}

impl From<String> for InternalError {
    fn from(_e: String) -> Self {
        Self::Failed
    }
}

impl From<String> for TxSyncError {
    fn from(_e: String) -> Self {
        Self::Failed
    }
}

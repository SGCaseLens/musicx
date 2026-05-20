use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ErrorPayload {
    pub message: String,
}

impl ErrorPayload {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub type AppResult<T> = Result<T, ErrorPayload>;

impl From<anyhow::Error> for ErrorPayload {
    fn from(value: anyhow::Error) -> Self {
        Self::new(value.to_string())
    }
}

impl From<rusqlite::Error> for ErrorPayload {
    fn from(value: rusqlite::Error) -> Self {
        Self::new(value.to_string())
    }
}

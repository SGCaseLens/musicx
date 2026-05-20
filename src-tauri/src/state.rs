use std::collections::HashSet;
use std::sync::Mutex;

#[derive(Default)]
pub struct AppState {
    pub active_downloads: Mutex<HashSet<String>>,
}

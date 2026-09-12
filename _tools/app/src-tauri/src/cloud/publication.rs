use serde::Serialize;
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishProgress {
    pub phase: &'static str,
    pub completed: u64,
    pub total: Option<u64>,
    pub unit: &'static str,
}
pub type Reporter<'a> = &'a (dyn Fn(PublishProgress) + Sync);
pub fn report(progress: Reporter<'_>, phase: &'static str, completed: u64, total: Option<u64>, unit: &'static str) {
    progress(PublishProgress { phase, completed, total, unit });
}

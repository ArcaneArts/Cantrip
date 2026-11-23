//! Route-level filtering uses the actual reference registrations.
#[derive(Clone, Copy, Debug)]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
    Silent,
}
impl LogLevel {
    fn parse(value: &str) -> Self {
        match value {
            "trace" => Self::Trace,
            "debug" => Self::Debug,
            "warn" => Self::Warn,
            "error" => Self::Error,
            "fatal" => Self::Fatal,
            "silent" => Self::Silent,
            _ => Self::Info,
        }
    }
    pub(super) fn incoming(self) -> bool {
        matches!(self, Self::Trace | Self::Debug | Self::Info)
    }
    pub(super) fn stream_warning(self) -> bool {
        self.incoming() || matches!(self, Self::Warn)
    }
}
pub(super) fn level(method: &str, target: &str) -> LogLevel {
    super::super::route_table::find(method, target)
        .ok()
        .flatten()
        .map_or(LogLevel::Info, |row| LogLevel::parse(&row.level))
}

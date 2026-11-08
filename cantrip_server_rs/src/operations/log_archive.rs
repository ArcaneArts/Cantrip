//! Serialized UTC daily JSONL archive. I/O errors are handled by the owning sink.
use crate::wire::Value;
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Datelike, TimeZone, Utc};
use flate2::{Compression, GzBuilder};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::UNIX_EPOCH,
};

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub struct Options {
    pub source: String,
    pub directory: PathBuf,
    pub legacy: Vec<String>,
    pub max_bytes: u64,
    pub part_bytes: u64,
    pub compression_age_ms: i64,
    pub clock: Clock,
}
impl Options {
    pub fn server(directory: PathBuf, legacy: Vec<String>) -> Self {
        Self {
            source: "server".into(),
            directory,
            legacy,
            max_bytes: 100 * 1024 * 1024,
            part_bytes: 10 * 1024 * 1024,
            compression_age_ms: 48 * 60 * 60 * 1000,
            clock: Arc::new(|| Utc::now().timestamp_millis()),
        }
    }
}
#[derive(Clone)]
struct Entry {
    name: String,
    size: u64,
    created: Option<f64>,
    modified: f64,
}
#[derive(Clone)]
struct Managed {
    entry: Entry,
    day: String,
    part: u64,
    compressed: bool,
}
fn pattern() -> &'static regex::Regex {
    static P: OnceLock<regex::Regex> = OnceLock::new();
    P.get_or_init(|| {
        regex::Regex::new(
            r"^([a-z0-9][a-z0-9-]*)-([0-9]{4}-[0-9]{2}-[0-9]{2})\.part-([0-9]{4})\.jsonl(\.gz)?$",
        )
        .unwrap()
    })
}
fn managed(entry: Entry, source: &str) -> Option<Managed> {
    let c = pattern().captures(&entry.name)?;
    if &c[1] != source {
        return None;
    }
    let day = c[2].to_owned();
    let part = c[3].parse().ok()?;
    let compressed = c.get(4).is_some();
    Some(Managed {
        entry,
        day,
        part,
        compressed,
    })
}
fn date(at: i64) -> Result<DateTime<Utc>> {
    DateTime::from_timestamp_millis(at).context("Invalid time value")
}
fn day(at: i64) -> Result<String> {
    Ok(crate::wire::date_iso_milliseconds(at)
        .context("Invalid time value")?
        .chars()
        .take(10)
        .collect())
}
fn name(source: &str, day: &str, part: u64) -> String {
    format!("{source}-{day}.part-{part:04}.jsonl")
}
fn stamp(value: std::time::SystemTime) -> f64 {
    match value.duration_since(UNIX_EPOCH) {
        Ok(v) => v.as_secs_f64() * 1000.0,
        Err(v) => -v.duration().as_secs_f64() * 1000.0,
    }
}
pub struct Archive {
    options: Options,
    active_bytes: u64,
    active_day: String,
    active_name: String,
    archive_bytes: u64,
    closed: bool,
    initialized: bool,
    pub next_delay_ms: Option<u64>,
}
impl Archive {
    pub fn new(mut options: Options) -> Result<Self> {
        options.source = crate::text::trim(&options.source).to_lowercase();
        if !regex::Regex::new(r"^[a-z0-9][a-z0-9-]*$")
            .unwrap()
            .is_match(&options.source)
        {
            bail!("Daily log archive source keys must use letters, numbers, or hyphens.")
        }
        if options.max_bytes == 0
            || options.part_bytes == 0
            || options.compression_age_ms <= 0
            || options.max_bytes > 9_007_199_254_740_991
            || options.part_bytes > 9_007_199_254_740_991
            || options.compression_age_ms > 9_007_199_254_740_991
        {
            bail!("Daily log archive limits must be positive safe integers.")
        }
        Ok(Self {
            options,
            active_bytes: 0,
            active_day: String::new(),
            active_name: String::new(),
            archive_bytes: 0,
            closed: false,
            initialized: false,
            next_delay_ms: None,
        })
    }
    fn ensure_directory(&self) -> Result<()> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&self.options.directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.options.directory, fs::Permissions::from_mode(0o700));
        }
        Ok(())
    }
    fn entries(&self) -> Result<Vec<Entry>> {
        self.ensure_directory()?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(&self.options.directory)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let metadata = entry.metadata()?;
            let created = metadata.created().ok().map(stamp).filter(|at| *at > 0.0);
            entries.push(Entry {
                name: entry.file_name().to_string_lossy().into_owned(),
                size: metadata.len(),
                created,
                modified: stamp(metadata.modified()?),
            });
        }
        Ok(entries)
    }
    fn managed_entries(&self) -> Result<Vec<Managed>> {
        let mut entries: Vec<_> = self
            .entries()?
            .into_iter()
            .filter_map(|entry| managed(entry, &self.options.source))
            .collect();
        entries.sort_by(|a, b| {
            a.day
                .cmp(&b.day)
                .then(a.part.cmp(&b.part))
                .then(a.compressed.cmp(&b.compressed))
        });
        Ok(entries)
    }
    fn path(&self, name: &str) -> Result<PathBuf> {
        if Path::new(name).file_name().and_then(|s| s.to_str()) != Some(name) {
            bail!("Archive file names cannot contain paths.")
        }
        Ok(self.options.directory.join(name))
    }
    fn remove(&self, name: &str) -> Result<()> {
        match fs::remove_file(self.path(name)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
    fn rename(&self, from: &str, to: &str) -> Result<()> {
        fs::rename(self.path(from)?, self.path(to)?)?;
        Ok(())
    }
    fn recover_temporary(&self) -> Result<()> {
        let entries = self.entries()?;
        let names: HashSet<_> = entries.iter().map(|e| e.name.as_str()).collect();
        for entry in &entries {
            if !entry.name.ends_with(".jsonl.gz.tmp") {
                continue;
            }
            let completed = &entry.name[..entry.name.len() - 4];
            let source = &completed[..completed.len() - 3];
            let mut candidate = entry.clone();
            candidate.name = completed.into();
            if managed(candidate, &self.options.source).is_some()
                && (names.contains(source) || names.contains(completed))
            {
                self.remove(&entry.name)?;
            }
        }
        Ok(())
    }
    fn migrate_legacy(&self) -> Result<()> {
        if self.options.legacy.is_empty() {
            return Ok(());
        }
        let mut legacy: Vec<_> = self
            .entries()?
            .into_iter()
            .filter(|entry| {
                self.options.legacy.iter().any(|base| {
                    entry.name == *base
                        || entry
                            .name
                            .strip_prefix(&format!("{base}."))
                            .is_some_and(|suffix| matches!(suffix, "1" | "2" | "3"))
                })
            })
            .collect();
        legacy.sort_by(|a, b| a.modified.total_cmp(&b.modified).then(a.name.cmp(&b.name)));
        let mut next = HashMap::<String, u64>::new();
        for e in self.managed_entries()? {
            next.entry(e.day)
                .and_modify(|v| *v = (*v).max(e.part))
                .or_insert(e.part);
        }
        for entry in legacy {
            let day = day(entry.created.unwrap_or(entry.modified) as i64)?;
            let part = next.entry(day.clone()).or_default();
            *part += 1;
            self.rename(&entry.name, &name(&self.options.source, &day, *part))?;
        }
        Ok(())
    }
    fn open_day(&mut self, day: &str) -> Result<()> {
        let entries = self.managed_entries()?;
        let newest = entries.iter().rfind(|e| e.day == day && !e.compressed);
        self.active_day = day.into();
        if let Some(entry) = newest.filter(|e| e.entry.size < self.options.part_bytes) {
            self.active_name = entry.entry.name.clone();
            self.active_bytes = entry.entry.size;
        } else {
            self.active_name = name(&self.options.source, day, newest.map_or(1, |e| e.part + 1));
            self.active_bytes = 0;
        }
        Ok(())
    }
    fn open_next(&mut self, day: &str) -> Result<()> {
        let part = self
            .managed_entries()?
            .iter()
            .filter(|e| e.day == day)
            .map(|e| e.part)
            .max()
            .unwrap_or(0)
            + 1;
        self.active_day = day.into();
        self.active_name = name(&self.options.source, day, part);
        self.active_bytes = 0;
        Ok(())
    }
    fn quota(&mut self) -> Result<()> {
        let entries = self.managed_entries()?;
        let mut total = entries.iter().map(|e| e.entry.size).sum::<u64>();
        for entry in entries {
            if total <= self.options.max_bytes {
                break;
            }
            if entry.entry.name == self.active_name {
                continue;
            }
            self.remove(&entry.entry.name)?;
            total -= entry.entry.size;
        }
        self.archive_bytes = total;
        Ok(())
    }
    fn compress(&self, source: &str, temporary: &str) -> Result<()> {
        let mut input = File::open(self.path(source)?)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let output = options.open(self.path(temporary)?)?;
        let mut encoder = GzBuilder::new()
            .operating_system(3)
            .mtime(0)
            .write(output, Compression::best());
        std::io::copy(&mut input, &mut encoder)?;
        encoder.finish()?;
        Ok(())
    }
    fn maintain_locked(&mut self) -> Result<()> {
        self.recover_temporary()?;
        let now = (self.options.clock)() as f64;
        for entry in self.managed_entries()? {
            if entry.compressed || entry.entry.name == self.active_name {
                continue;
            }
            let created = match entry.entry.created {
                Some(at) => at,
                None => {
                    crate::wire::date_milliseconds(&format!("{}T23:59:59.999Z", entry.day).into())
                        .map_or(f64::NAN, |at| at as f64)
                }
            };
            if now - created <= self.options.compression_age_ms as f64 {
                continue;
            }
            let completed = format!("{}.gz", entry.entry.name);
            let temporary = format!("{completed}.tmp");
            if self.entries()?.iter().any(|e| e.name == completed) {
                self.remove(&entry.entry.name)?;
                continue;
            }
            self.compress(&entry.entry.name, &temporary)?;
            self.rename(&temporary, &completed)?;
            self.remove(&entry.entry.name)?;
        }
        self.quota()
    }
    fn schedule(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        let now = (self.options.clock)();
        let current = date(now)?;
        let year = if (0..=99).contains(&current.year()) {
            current.year() + 1900
        } else {
            current.year()
        };
        let first = Utc
            .with_ymd_and_hms(year, current.month(), 1, 0, 0, 0)
            .single()
            .context("Invalid time value")?;
        let next = (first + chrono::Duration::days(current.day() as i64)).timestamp_millis();
        self.next_delay_ms = Some((next - now).max(1) as u64);
        Ok(())
    }
    pub fn initialize(&mut self) -> Result<()> {
        if self.initialized || self.closed {
            return Ok(());
        }
        self.ensure_directory()?;
        self.recover_temporary()?;
        self.migrate_legacy()?;
        self.open_day(&day((self.options.clock)())?)?;
        self.maintain_locked()?;
        self.initialized = true;
        self.schedule()
    }
    pub fn append(&mut self, record: &Value) -> Result<()> {
        let line = format!("{}\n", record.stringify());
        if self.closed {
            return Ok(());
        }
        self.initialize()?;
        let day = day((self.options.clock)())?;
        if day != self.active_day {
            self.open_day(&day)?;
            self.maintain_locked()?;
            self.schedule()?;
        }
        if self.active_bytes > 0 && self.active_bytes + line.len() as u64 > self.options.part_bytes
        {
            self.open_next(&day)?;
        }
        let path = self.path(&self.active_name)?;
        let mut options = OpenOptions::new();
        options.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path)?.write_all(line.as_bytes())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        self.active_bytes += line.len() as u64;
        self.archive_bytes += line.len() as u64;
        if self.archive_bytes > self.options.max_bytes {
            self.quota()?;
        }
        Ok(())
    }
    pub fn maintain(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        self.initialize()?;
        let day = day((self.options.clock)())?;
        if day != self.active_day {
            self.open_day(&day)?;
        }
        self.maintain_locked()?;
        self.schedule()
    }
    pub fn close(&mut self) {
        self.closed = true;
        self.next_delay_ms = None;
    }
}

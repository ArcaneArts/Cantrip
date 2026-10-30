//! Preserve the host settings before an embedded database changes libc's
//! process-wide environment. The Node server's WASM database cannot change its
//! JavaScript host's locale or timezone in this way.
use jiff::tz::{TimeZone, TimeZoneDatabase};
use std::sync::OnceLock;

struct Host {
    locale: Option<String>,
    timezone: TimeZone,
}

fn host() -> &'static Host {
    static HOST: OnceLock<Host> = OnceLock::new();
    HOST.get_or_init(|| Host {
        locale: host_locale(),
        timezone: match std::env::var("TZ") {
            Ok(name) => TimeZoneDatabase::bundled()
                .get(&name)
                .ok()
                .filter(|zone| zone.iana_name() == Some(name.as_str()))
                .unwrap_or_else(unknown_zone),
            Err(_) => TimeZone::system(),
        },
    })
}

fn host_locale() -> Option<String> {
    // ICU honors these POSIX variables on Unix, including macOS. sys-locale's
    // macOS implementation instead consults preferences, and its Unix variant
    // also considers LANGUAGE, which ICU's default collation does not use.
    #[cfg(unix)]
    for name in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        let Ok(value) = std::env::var(name) else {
            continue;
        };
        if value.is_empty() {
            return Some("und".into());
        }
        let (base, modifier) = value.split_once('@').unwrap_or((&value, ""));
        let mut locale = base.split('.').next().unwrap_or(base).replace('_', "-");
        if matches!(locale.as_str(), "C" | "POSIX") {
            return Some("en-US".into());
        }
        // V8 maps the POSIX English default to ordinary en-US.
        if locale.eq_ignore_ascii_case("en-US-POSIX") {
            locale = "en-US".into();
        }
        if !modifier.is_empty() && !modifier.contains('=') {
            let candidate = format!("{locale}-{modifier}");
            if candidate.parse::<icu_locale_core::Locale>().is_ok() {
                locale = candidate;
            }
        }
        return Some(locale);
    }
    #[cfg(all(unix, not(target_vendor = "apple")))]
    return Some("en-US".into());
    #[cfg(any(not(unix), target_vendor = "apple"))]
    sys_locale::get_locale()
}

pub(crate) fn locale() -> Option<&'static str> {
    host().locale.as_deref()
}

pub(crate) fn timezone() -> &'static TimeZone {
    &host().timezone
}

pub(crate) fn pglite_default_timezone() -> anyhow::Result<String> {
    // PGlite's WASM initdb observes Emscripten's standard host offset and picks
    // an integer-hour Etc/GMT zone. It does not use the host's historical IANA
    // rules. Preserve this separately from the server's Date parser timezone.
    let zone = timezone();
    let year = jiff::Timestamp::now().to_zoned(zone.clone()).year();
    let january = jiff::civil::date(year, 1, 1)
        .at(0, 0, 0, 0)
        .to_zoned(zone.clone())?;
    let july = jiff::civil::date(year, 7, 1)
        .at(0, 0, 0, 0)
        .to_zoned(zone.clone())?;
    let hours_west = -january.offset().seconds().min(july.offset().seconds()) / 3600;
    Ok(if hours_west == 0 {
        "Etc/GMT0".into()
    } else {
        format!("Etc/GMT{hours_west:+}")
    })
}

#[cfg(unix)]
fn unknown_zone() -> TimeZone {
    // ICU uses a fixed host standard offset when TZ is not an exact ICU zone
    // ID. Resolve this while libc still sees the caller's original environment.
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    unsafe extern "C" {
        fn tzset();
        #[link_name = "timezone"]
        static HOST_SECONDS_WEST: std::ffi::c_long;
    }
    let _guard = LOCK.lock().unwrap();
    // SAFETY: tzset has no arguments; timezone is libc's initialized standard
    // seconds-west value. Calls from this module are serialized by LOCK.
    let seconds = unsafe {
        tzset();
        -HOST_SECONDS_WEST
    };
    i32::try_from(seconds)
        .ok()
        .and_then(|seconds| jiff::tz::Offset::from_seconds(seconds).ok())
        .map_or(TimeZone::UTC, TimeZone::fixed)
}

#[cfg(windows)]
fn unknown_zone() -> TimeZone {
    // Node sets the ICU default from TZ on Windows. Unknown IDs use zero offset.
    TimeZone::UTC
}

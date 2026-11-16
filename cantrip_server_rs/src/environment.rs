//! Database timezone policy uses the shared host snapshot.
pub(crate) use cantrip_wire::environment::{locale, timezone};

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

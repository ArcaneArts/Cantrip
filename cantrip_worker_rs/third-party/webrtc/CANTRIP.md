# WebRTC.rs 0.21.1

The worker uses the library source from [WebRTC.rs v0.21.1](https://github.com/webrtc-rs/webrtc/releases/tag/v0.21.1).
The Cargo manifest uses the published RTC crate and includes the library targets.
Both upstream licenses are included.

Cantrip adds a runtime hook for admitting gathered UDP candidates before they
enter ICE. This lets ordinary private interfaces gather STUN mappings for WAN
without admitting their host candidates on that route. The hook defaults to
the upstream behavior for other runtimes.

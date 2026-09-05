fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // The helper still starts on pre-ScreenCaptureKit systems. The native
        // module checks actual class/selector availability before invoking it.
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
    }
}
